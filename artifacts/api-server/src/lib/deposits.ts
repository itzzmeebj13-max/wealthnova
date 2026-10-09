import { Prisma, type DepositPaymentSettings, type DepositRequest, type PrismaClient } from "@prisma/client";
import { prisma } from "@workspace/db";
import type { DepositRequestInput } from "@workspace/api-zod";
import { DepositError } from "./private-images";

export async function getPaymentSettings(database: Pick<PrismaClient, "depositPaymentSettings"> = prisma) {
  return database.depositPaymentSettings.upsert({
    where: { id: "gcash" }, create: { id: "gcash" }, update: {},
  });
}

export function settingsConfigured(settings: DepositPaymentSettings) {
  return Boolean(settings.qrImageId && settings.accountName.trim() &&
    /^\+639\d{9}$/.test(settings.accountNumber) && settings.instructions.trim() &&
    settings.minimumAmount.gte(350));
}

export function depositsEnabled(settings: DepositPaymentSettings) {
  return settingsConfigured(settings) && settings.accountDetailsConfirmed && settings.submissionsEnabled;
}

export function paymentBlockingReasons(settings: DepositPaymentSettings) {
  const reasons: string[] = [];
  if (!settings.qrImageId) reasons.push("Upload the real receiving GCash QR code.");
  if (!settings.accountName.trim()) reasons.push("Enter the actual GCash account name.");
  if (!/^\+639\d{9}$/.test(settings.accountNumber)) reasons.push("Enter the actual Philippine GCash account number.");
  if (!settings.instructions.trim()) reasons.push("Enter deposit instructions.");
  if (settings.minimumAmount.lt(350)) reasons.push("Set a minimum deposit of at least ₱350.");
  if (!settings.accountDetailsConfirmed) reasons.push("Confirm the QR code and account details belong to the intended receiving account.");
  if (!settings.submissionsEnabled) reasons.push("The Admin submission switch is off.");
  return reasons;
}

export function mapPaymentSettings(settings: DepositPaymentSettings) {
  const configured = settingsConfigured(settings);
  return {
    configured, enabled: depositsEnabled(settings),
    accountDetailsConfirmed: settings.accountDetailsConfirmed,
    blockingReasons: paymentBlockingReasons(settings),
    submissionsEnabled: settings.submissionsEnabled,
    accountName: settings.accountName, accountNumber: settings.accountNumber,
    instructions: settings.instructions, minimumAmount: settings.minimumAmount.toFixed(2),
    qrImageId: settings.qrImageId,
    qrImageUrl: settings.qrImageId ? `/api/deposits/images/${settings.qrImageId}` : null,
    version: settings.version,
  };
}

export function mapDepositRequest(record: DepositRequest) {
  return {
    id: record.id, amount: record.amount.toFixed(2),
    transactionReference: record.transactionReference,
    receiptUrl: `/api/deposits/images/${record.receiptImageId}`,
    status: record.status, accountName: record.accountName,
    accountNumber: record.accountNumber, createdAt: record.createdAt.toISOString(),
    rejectionReason: record.rejectionReason,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    approvedAt: record.approvedAt?.toISOString() ?? null,
    verifiedAmount: record.verifiedAmount?.toFixed(2) ?? null,
  };
}

export function normalizeTransactionReference(value: string) {
  const reference = value.trim().replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{6,64}$/.test(reference)) {
    throw new DepositError("Please enter a valid GCash transaction reference (6–64 letters or digits).");
  }
  return reference;
}

export type DepositDatabase = Pick<PrismaClient, "depositRequest"> & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel: Prisma.TransactionIsolationLevel }): Promise<T>;
};

export async function submitDeposit(userId: string, input: DepositRequestInput, database: DepositDatabase = prisma) {
  const amount = new Prisma.Decimal(input.amount);
  if (!amount.gt(0)) throw new DepositError("Please enter a positive deposit amount.");
  const transactionReference = normalizeTransactionReference(input.transactionReference);
  const lookup = { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } };
  function replay(record: DepositRequest) {
    if (!record.amount.equals(amount) || record.transactionReference !== transactionReference ||
        record.receiptImageId !== input.receiptImageId || record.settingsVersion !== input.settingsVersion) {
      throw new DepositError("This request key was already used for different deposit details.", 409);
    }
    return { record, replayed: true };
  }
  const existing = await database.depositRequest.findUnique({ where: lookup });
  if (existing) return replay(existing);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await database.$transaction(async tx => {
        const existing = await tx.depositRequest.findUnique({ where: lookup });
        if (existing) return replay(existing);
        const settings = await tx.depositPaymentSettings.findUnique({ where: { id: "gcash" } });
        if (!settings || !depositsEnabled(settings)) {
          throw new DepositError("Manual deposit submissions are disabled or the receiving account details are unconfirmed.", 409);
        }
        if (settings.version !== input.settingsVersion) {
          throw new DepositError("Payment details changed. Please reload and check the current details before submitting.", 409);
        }
        if (amount.lt(settings.minimumAmount)) {
          throw new DepositError(`The minimum deposit amount is ₱${settings.minimumAmount.toFixed(2)}.`);
        }
        const image = await tx.depositImage.findUnique({ where: { id: input.receiptImageId } });
        if (!image || image.userId !== userId || image.purpose !== "RECEIPT") {
          throw new DepositError("Please upload your own valid payment receipt.");
        }
        const count = await tx.depositRequest.count({
          where: { userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
        });
        if (count >= 20) throw new DepositError("Too many deposit requests. Please try again later.", 429);
        const record = await tx.depositRequest.create({
          data: {
            userId, amount, transactionReference, receiptImageId: image.id,
            receiptDigest: image.digest, idempotencyKey: input.idempotencyKey,
            accountName: settings.accountName, accountNumber: settings.accountNumber,
            settingsVersion: settings.version, status: "PENDING_VERIFICATION",
          },
        });
        // Intentionally no Wallet or LedgerEntry write. Submission is not proof of payment.
        return { record, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2034") {
          if (attempt < 2) continue;
          throw new DepositError("The request is busy. Please retry safely.", 409);
        }
        if (error.code === "P2002") {
          const existing = await database.depositRequest.findUnique({ where: lookup });
          if (existing) return replay(existing);
          throw new DepositError("This transaction reference or receipt has already been submitted.", 409);
        }
      }
      throw error;
    }
  }
  throw new DepositError("Please retry safely.", 409);
}
