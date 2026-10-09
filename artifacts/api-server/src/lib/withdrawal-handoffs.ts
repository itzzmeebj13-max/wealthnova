import { prisma } from "@workspace/db";
import type { WithdrawalHandoffInput } from "@workspace/api-zod";
import { DepositError } from "./private-images";
import { normalizeTransactionReference } from "./deposits";
import { withdrawalAmounts, withdrawalInclude, withdrawalTransaction, type WithdrawalDatabase } from "./withdrawals";

// A takeover accepts responsibility, not permission to send money. External
// coordination must stop the old processor before this operation is attempted.
export async function handoffWithdrawal(adminId: string, withdrawalId: string, input: WithdrawalHandoffInput, database: WithdrawalDatabase = prisma) {
  const note = input.reconciliationNote.trim();
  if (!input.confirmedPreviousProcessorStopped || note.length < 20 || note.length > 1000) {
    throw new DepositError("Document payment reconciliation and confirm the previous processor can no longer send this payout.");
  }
  const sent = input.payoutStatus === "SENT";
  if (!sent && input.payoutStatus !== "NOT_SENT") throw new DepositError("Unknown payment status cannot be handed off.");
  if (!sent && (input.payoutReference || input.paidAmount)) throw new DepositError("Unsent reconciliation cannot contain a sent payment.");
  const reference = sent ? normalizeTransactionReference(input.payoutReference ?? "") : null;
  return withdrawalTransaction(database, async tx => {
    const admin = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, status: true } });
    if (!admin || admin.role !== "ADMIN" || admin.status !== "ACTIVE") throw new DepositError("Active Administrator access is required.", 403);
    const record = await tx.withdrawalRequest.findUnique({ where: { id: withdrawalId }, include: withdrawalInclude });
    if (!record) throw new DepositError("Withdrawal not found.", 404);
    if (record.userId === adminId) throw new DepositError("Administrators cannot review their own withdrawals.", 403);
    if (record.status !== "PROCESSING" || !record.processingById || record.processingById === adminId ||
        record.processingById !== input.expectedProcessorId || record.updatedAt.toISOString() !== new Date(input.expectedUpdatedAt).toISOString()) {
      throw new DepositError("Processing ownership changed or is already yours. Reload and reconcile again before a handoff.", 409);
    }
    if (record.payoutReference && (!sent || record.payoutReference !== reference)) {
      throw new DepositError("A payout is already recorded. Never resend or remove its payment evidence.", 409);
    }
    if (sent && !withdrawalAmounts(input.paidAmount ?? "").amount.equals(record.netAmount)) {
      throw new DepositError("Reconciled paid amount must exactly equal the net payout.");
    }
    if (reference) {
      const used = await tx.withdrawalRequest.findUnique({ where: { payoutReference: reference } });
      if (used && used.id !== record.id) throw new DepositError("This payout reference belongs to another withdrawal.", 409);
    }
    const changed = await tx.withdrawalRequest.updateMany({
      where: { id: record.id, status: "PROCESSING", processingById: input.expectedProcessorId, updatedAt: record.updatedAt },
      data: { processingById: adminId,
        // Advance even if successive takeovers happen in the same millisecond.
        updatedAt: new Date(Math.max(Date.now(), record.updatedAt.getTime() + 1)),
        ...(sent ? { payoutReference: reference, verificationNote: record.verificationNote ?? note } : {}) },
    });
    if (changed.count !== 1) throw new DepositError("Another review changed this request. Reload before continuing.", 409);
    await tx.withdrawalHandoff.create({ data: {
      withdrawalId, fromAdminId: input.expectedProcessorId, toAdminId: adminId,
      payoutStatus: input.payoutStatus, payoutReference: reference, note,
    } });
    // No status, wallet, reservation, ledger or existing audit is changed.
    return tx.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawalId }, include: withdrawalInclude });
  });
}
