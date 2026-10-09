import { Prisma } from "@prisma/client";
import { prisma } from "@workspace/db";
import { normalizePhilippineMobileNumber, type DepositPaymentSettingsInput } from "@workspace/api-zod";
import { DepositError } from "./private-images";
import { settingsConfigured, type DepositDatabase } from "./deposits";

export async function saveDepositSettings(
  adminId: string,
  input: DepositPaymentSettingsInput,
  database: DepositDatabase = prisma,
) {
  const accountName = input.accountName.trim();
  const accountNumber = input.accountNumber.trim() ? normalizePhilippineMobileNumber(input.accountNumber) : "";
  if (accountNumber === null) throw new DepositError("Please enter a valid Philippine mobile number for the GCash account.");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(input.minimumAmount)) throw new DepositError("Enter a valid minimum deposit amount.");
  const minimumAmount = new Prisma.Decimal(input.minimumAmount);
  if (minimumAmount.lt(350)) throw new DepositError("The minimum deposit must be at least ₱350.");
  try {
    return await database.$transaction(async tx => {
      const admin = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, status: true } });
      if (!admin || admin.role !== "ADMIN" || admin.status !== "ACTIVE") {
        throw new DepositError("An active authorized administrator is required.", 403);
      }
      const current = await tx.depositPaymentSettings.upsert({
        where: { id: "gcash" }, create: { id: "gcash" }, update: {},
      });
      if (current.version !== input.expectedVersion) throw new DepositError("Payment settings changed. Reload before saving.", 409);
      if (input.qrImageId) {
        const qr = await tx.depositImage.findUnique({ where: { id: input.qrImageId } });
        if (!qr || qr.purpose !== "QR") throw new DepositError("Please upload a valid GCash QR image.");
      }
      const data = {
        qrImageId: input.qrImageId, accountName, accountNumber,
        instructions: input.instructions.trim(), minimumAmount,
        submissionsEnabled: input.submissionsEnabled,
        accountDetailsConfirmed: input.accountDetailsConfirmed === true,
      };
      const configured = settingsConfigured({ ...current, ...data });
      if ((data.submissionsEnabled || data.accountDetailsConfirmed) && !configured) {
        throw new DepositError("Complete the real QR code, account name, Philippine account number, instructions, and minimum amount before confirming or enabling deposits.");
      }
      if (data.submissionsEnabled && !data.accountDetailsConfirmed) {
        throw new DepositError("Confirm that the QR code and account details belong to the actual receiving GCash account before enabling submissions.");
      }
      const changed = await tx.depositPaymentSettings.updateMany({
        where: { id: "gcash", version: input.expectedVersion },
        data: { ...data, version: { increment: 1 } },
      });
      if (changed.count !== 1) throw new DepositError("Payment settings changed. Reload before saving.", 409);
      return tx.depositPaymentSettings.findUniqueOrThrow({ where: { id: "gcash" } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new DepositError("Payment settings changed concurrently. Reload before saving.", 409);
    }
    throw error;
  }
}
