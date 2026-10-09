import { prisma } from "@workspace/db";
import { type CompleteWithdrawalInput, type RejectWithdrawalInput } from "@workspace/api-zod";
import { DepositError } from "./private-images";
import { normalizeTransactionReference } from "./deposits";
import { withdrawalAmounts, withdrawalInclude, withdrawalTransaction, type WithdrawalDatabase } from "./withdrawals";

type Decision = { type: "PROCESS" } | { type: "COMPLETE"; data: CompleteWithdrawalInput } | { type: "REJECT"; data: RejectWithdrawalInput };
export async function decideWithdrawal(adminId: string, withdrawalId: string, decision: Decision, database: WithdrawalDatabase = prisma) {
  let reference: string | null = null;
  let note = "Request reviewed and claimed for processing; no payout is confirmed.";
  if (decision.type === "COMPLETE") {
    if (!decision.data.confirmedPayoutSent) throw new DepositError("Independently verify that the actual GCash payout was sent before completing.");
    reference = normalizeTransactionReference(decision.data.payoutReference);
    note = decision.data.verificationNote.trim();
    if (note.length < 10 || note.length > 1000) throw new DepositError("Provide a verification note (10–1000 characters).");
  }
  if (decision.type === "REJECT") {
    note = decision.data.reason.trim();
    if (note.length < 5 || note.length > 1000) throw new DepositError("Provide a rejection reason (5–1000 characters).");
    if (!decision.data.confirmedNoPayoutSent) throw new DepositError("Confirm that no payout was sent before releasing funds.");
  }
  return withdrawalTransaction(database, async tx => {
    const admin = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, status: true } });
    if (!admin || admin.role !== "ADMIN" || admin.status !== "ACTIVE") throw new DepositError("Active Administrator access is required.", 403);
    const record = await tx.withdrawalRequest.findUnique({ where: { id: withdrawalId }, include: withdrawalInclude });
    if (!record) throw new DepositError("Withdrawal not found.", 404);
    if (record.userId === adminId) throw new DepositError("Administrators cannot review their own withdrawals.", 403);
    if (decision.type === "COMPLETE" && !withdrawalAmounts(decision.data.paidAmount).amount.equals(record.netAmount)) {
      throw new DepositError("The actual paid amount must match this withdrawal's net payout exactly.");
    }
    const status = decision.type === "PROCESS" ? "PROCESSING" : decision.type === "COMPLETE" ? "COMPLETED" : "REJECTED";
    if (record.status === status) {
      const same = decision.type === "PROCESS" ? record.processingById === adminId
        : decision.type === "COMPLETE" ? record.payoutReference === reference && record.processingById === adminId
        : record.rejectionReason === note;
      if (!same) throw new DepositError("This withdrawal has already been decided or claimed differently.", 409);
      return record;
    }
    if (record.status === "COMPLETED" || record.status === "REJECTED") throw new DepositError("Final withdrawal decisions cannot be changed.", 409);
    if (record.status === "PROCESSING" && record.processingById !== adminId) {
      throw new DepositError("Another Administrator is handling this payout. Only the assigned processor can complete or reject it.", 409);
    }
    if (decision.type === "COMPLETE" && record.status !== "PROCESSING") {
      throw new DepositError("Review and start Processing before recording the actual payout.", 409);
    }
    if (reference && await tx.withdrawalRequest.findUnique({ where: { payoutReference: reference } })) {
      throw new DepositError("That GCash payout reference was already used. No duplicate payout was recorded.", 409);
    }
    const now = new Date();
    const changed = await tx.withdrawalRequest.updateMany({
      where: { id: record.id, status: record.status, processingById: record.processingById },
      data: decision.type === "PROCESS"
        ? { status, processingById: adminId, processedAt: now }
        : { status, reviewedById: adminId, reviewedAt: now,
          completedAt: decision.type === "COMPLETE" ? now : null,
          payoutReference: reference, verificationNote: decision.type === "COMPLETE" ? note : null,
          rejectionReason: decision.type === "REJECT" ? note : null },
    });
    if (changed.count !== 1) throw new DepositError("Another review changed this request. Reload before continuing.", 409);
    if (decision.type !== "PROCESS") {
      const before = await tx.wallet.findUniqueOrThrow({ where: { userId: record.userId } });
      const released = await tx.wallet.updateMany({
        where: { userId: record.userId, activeWithdrawalId: record.id, reservedBalance: { gte: record.requestedAmount } },
        data: { reservedBalance: { decrement: record.requestedAmount }, activeWithdrawalId: null,
          ...(decision.type === "REJECT" ? { availableBalance: { increment: record.requestedAmount } } : {}) },
      });
      if (released.count !== 1) throw new DepositError("Reserved funds do not match this request. No financial change was applied.", 409);
      const after = await tx.wallet.findUniqueOrThrow({ where: { userId: record.userId } });
      const base = { userId: record.userId, withdrawalId: record.id, createdAt: now };
      await tx.ledgerEntry.createMany({ data: decision.type === "REJECT" ? [
        { ...base, reference: `withdrawal:${record.id}:unhold`, type: "WITHDRAWAL_UNHOLD", balanceBucket: "RESERVED",
          amount: record.requestedAmount.negated(), balanceAfter: after.reservedBalance },
        { ...base, reference: `withdrawal:${record.id}:release`, type: "WITHDRAWAL_RELEASE", balanceBucket: "AVAILABLE",
          amount: record.requestedAmount, balanceAfter: after.availableBalance },
      ] : [
        { ...base, reference: `withdrawal:${record.id}:payout`, type: "WITHDRAWAL_PAYOUT", balanceBucket: "RESERVED",
          amount: record.netAmount.negated(), balanceAfter: before.reservedBalance.minus(record.netAmount) },
        { ...base, reference: `withdrawal:${record.id}:fee`, type: "WITHDRAWAL_FEE", balanceBucket: "RESERVED",
          amount: record.feeAmount.negated(), balanceAfter: after.reservedBalance },
      ] });
    }
    await tx.withdrawalAudit.create({ data: { withdrawalId, adminId, decision: status, payoutReference: reference, note, createdAt: now } });
    const message = decision.type === "REJECT"
      ? `Withdrawal rejected: ${note} The full ₱${record.requestedAmount.toFixed(2)} reservation was released to your available balance.`
      : decision.type === "PROCESS" ? "An Administrator started processing your withdrawal. No payout was confirmed at that stage."
      : `Your ₱${record.netAmount.toFixed(2)} GCash payout was recorded as verified by an Administrator. Reference: ${reference}.`;
    await tx.withdrawalNotification.create({ data: { userId: record.userId, withdrawalId, status, message, createdAt: now } });
    return tx.withdrawalRequest.findUniqueOrThrow({ where: { id: withdrawalId }, include: withdrawalInclude });
  });
}
