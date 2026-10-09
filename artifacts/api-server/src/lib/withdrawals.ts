import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@workspace/db";
import { normalizePhilippineMobileNumber, type WithdrawalInput } from "@workspace/api-zod";
import { DepositError } from "./private-images";

export type WithdrawalDatabase = Pick<PrismaClient, "wallet" | "withdrawalRequest" | "withdrawalAudit" | "withdrawalNotification"> & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel: Prisma.TransactionIsolationLevel }): Promise<T>;
};
export const withdrawalInclude = { user: { select: { mobileNumber: true } } } as const;
export type WithdrawalRecord = Prisma.WithdrawalRequestGetPayload<{ include: typeof withdrawalInclude }>;

export function withdrawalAmounts(raw: string) {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) throw new DepositError("Enter a valid PHP amount with at most two decimal places.");
  const amount = new Prisma.Decimal(raw);
  if (amount.lte(0)) throw new DepositError("The withdrawal amount must be greater than zero.");
  const fee = amount.mul("0.05").toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const net = amount.minus(fee);
  if (net.lte(0)) throw new DepositError("The net payout must be positive.");
  return { amount, fee, net };
}
export function mapWithdrawal(record: WithdrawalRecord) {
  return {
    id: record.id, userId: record.userId, userMobileNumber: record.user.mobileNumber,
    requestedAmount: record.requestedAmount.toFixed(2), feeAmount: record.feeAmount.toFixed(2),
    netAmount: record.netAmount.toFixed(2), feePercent: record.feeBasisPoints / 100,
    accountName: record.accountName, accountNumber: record.accountNumber, status: record.status,
    processingById: record.processingById, reviewedById: record.reviewedById,
    processedAt: record.processedAt?.toISOString() ?? null, completedAt: record.completedAt?.toISOString() ?? null,
    payoutReference: record.payoutReference, verificationNote: record.verificationNote,
    rejectionReason: record.rejectionReason, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  };
}
export async function withdrawalTransaction<T>(database: WithdrawalDatabase, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await database.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) {
        if (attempt < 2) continue;
        throw new DepositError("A concurrent or duplicate financial operation was prevented. Retry the same request safely.", 409);
      }
      throw error;
    }
  }
  throw new DepositError("Please retry the same request safely.", 409);
}

export async function requestWithdrawal(userId: string, input: WithdrawalInput, database: WithdrawalDatabase = prisma) {
  const { amount, fee, net } = withdrawalAmounts(input.amount);
  const accountName = input.accountName.trim();
  const accountNumber = normalizePhilippineMobileNumber(input.accountNumber);
  if (!accountName || accountName.length > 120) throw new DepositError("Enter the actual GCash account name.");
  if (!accountNumber) throw new DepositError("Please enter a valid Philippine GCash mobile number.");
  return withdrawalTransaction(database, async tx => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== "ACTIVE") throw new DepositError("An active signed-in account is required.", 403);
    const existing = await tx.withdrawalRequest.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } }, include: withdrawalInclude,
    });
    if (existing) {
      if (!existing.requestedAmount.equals(amount) || existing.accountName !== accountName || existing.accountNumber !== accountNumber) {
        throw new DepositError("This retry key belongs to different withdrawal details.", 409);
      }
      return existing;
    }
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (wallet?.activeWithdrawalId) throw new DepositError("You already have a Pending or Processing withdrawal. Wait for its decision before requesting another.", 409);
    if (!wallet || wallet.availableBalance.lt(amount)) throw new DepositError("Insufficient available verified balance.", 409);
    const request = await tx.withdrawalRequest.create({
      data: { userId, requestedAmount: amount, feeAmount: fee, netAmount: net, feeBasisPoints: 500, accountName, accountNumber, idempotencyKey: input.idempotencyKey },
      include: withdrawalInclude,
    });
    const changed = await tx.wallet.updateMany({
      where: { userId, availableBalance: { gte: amount }, activeWithdrawalId: null },
      data: { availableBalance: { decrement: amount }, reservedBalance: { increment: amount }, activeWithdrawalId: request.id },
    });
    if (changed.count !== 1) throw new DepositError("Balance or withdrawal state changed. Retry safely.", 409);
    const held = await tx.wallet.findUniqueOrThrow({ where: { userId } });
    await tx.ledgerEntry.createMany({ data: [
      { userId, withdrawalId: request.id, reference: `withdrawal:${request.id}:reserve`, type: "WITHDRAWAL_RESERVE",
        amount: amount.negated(), balanceBucket: "AVAILABLE", balanceAfter: held.availableBalance },
      { userId, withdrawalId: request.id, reference: `withdrawal:${request.id}:hold`, type: "WITHDRAWAL_HOLD",
        amount, balanceBucket: "RESERVED", balanceAfter: held.reservedBalance },
    ] });
    return request;
  });
}

export async function withdrawalSummary(userId: string, database: WithdrawalDatabase = prisma) {
  const [wallet, notifications] = await Promise.all([
    database.wallet.findUnique({ where: { userId } }),
    database.withdrawalNotification.findMany({ where: { userId, readAt: null }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return {
    availableBalance: wallet?.availableBalance.toFixed(2) ?? "0.00",
    reservedBalance: wallet?.reservedBalance.toFixed(2) ?? "0.00",
    activeWithdrawalId: wallet?.activeWithdrawalId ?? null, feePercent: 5,
    notifications: notifications.map(n => ({ id: n.id, withdrawalId: n.withdrawalId, message: n.message, createdAt: n.createdAt.toISOString() })),
  };
}
