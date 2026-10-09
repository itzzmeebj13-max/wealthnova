import { Prisma } from "@prisma/client";
import { prisma } from "@workspace/db";
import type { DepositApprovalInput, DepositRejectionInput } from "@workspace/api-zod";
import { DepositError } from "./private-images";
import { mapDepositRequest, type DepositDatabase } from "./deposits";

export const depositReviewInclude = {
  user: { select: { id: true, mobileNumber: true } },
  reviewedBy: { select: { id: true, mobileNumber: true } },
} satisfies Prisma.DepositRequestInclude;

type ReviewedDeposit = Prisma.DepositRequestGetPayload<{ include: typeof depositReviewInclude }>;
type Decision =
  | { type: "APPROVE"; data: DepositApprovalInput }
  | { type: "REJECT"; data: DepositRejectionInput };

export function mapAdminDeposit(deposit: ReviewedDeposit) {
  return { ...mapDepositRequest(deposit), user: deposit.user, reviewer: deposit.reviewedBy };
}

export async function decideDeposit(
  adminId: string,
  depositId: string,
  decision: Decision,
  database: DepositDatabase = prisma,
) {
  const approving = decision.type === "APPROVE";
  let verifiedAmount: Prisma.Decimal | null = null;
  let verificationNote: string | null = null;
  let rejectionReason: string | null = null;
  if (decision.type === "APPROVE") {
    if (decision.data.confirmedPaymentReceived !== true) {
      throw new DepositError("Independently confirm the payment was received before approving.");
    }
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(decision.data.verifiedAmount)) {
      throw new DepositError("Please enter the exact verified payment amount.");
    }
    verifiedAmount = new Prisma.Decimal(decision.data.verifiedAmount);
    verificationNote = decision.data.verificationNote.trim();
    if (!verifiedAmount.gt(0) || verificationNote.length < 10 || verificationNote.length > 1000) {
      throw new DepositError("Enter a positive verified amount and a meaningful verification note (10–1000 characters).");
    }
  } else {
    rejectionReason = decision.data.reason.trim();
    if (rejectionReason.length < 5 || rejectionReason.length > 1000) {
      throw new DepositError("Please provide a rejection reason (5–1000 characters).");
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await database.$transaction(async tx => {
        // Recheck the real database role inside the financial transaction.
        const admin = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, status: true } });
        if (!admin || admin.role !== "ADMIN" || admin.status !== "ACTIVE") {
          throw new DepositError("An active authorized administrator is required.", 403);
        }
        const deposit = await tx.depositRequest.findUnique({
          where: { id: depositId }, include: depositReviewInclude,
        });
        if (!deposit) throw new DepositError("Deposit request not found.", 404);
        if (approving && deposit.userId === adminId) {
          throw new DepositError("You cannot approve your own deposit. Another administrator must verify it.", 403);
        }
        const amountDiffers = approving && !verifiedAmount!.equals(deposit.amount);
        if (amountDiffers && decision.type === "APPROVE" && decision.data.confirmedAmountDifference !== true) {
          throw new DepositError("Explicitly acknowledge that the verified payment differs from the requested amount.");
        }
        const status = approving ? "APPROVED" as const : "REJECTED" as const;
        if (deposit.status !== "PENDING_VERIFICATION") {
          if (deposit.status !== status ||
              (approving && !deposit.verifiedAmount?.equals(verifiedAmount!)) ||
              (!approving && deposit.rejectionReason !== rejectionReason)) {
            throw new DepositError("This request has already been decided and cannot be changed.", 409);
          }
          // A repeat is not a new decision: retain the original reviewer/audit.
          return { deposit, alreadyProcessed: true };
        }
        const now = new Date();
        const changed = await tx.depositRequest.updateMany({
          where: { id: depositId, status: "PENDING_VERIFICATION" },
          data: {
            status, reviewedById: adminId, reviewedAt: now,
            approvedAt: approving ? now : null,
            verifiedAmount: approving ? verifiedAmount : null,
            rejectionReason,
          },
        });
        if (changed.count !== 1) {
          throw new DepositError("Another administrator decided this request. Reload or retry safely.", 409);
        }
        if (approving) {
          await tx.wallet.upsert({
            where: { userId: deposit.userId },
            create: { userId: deposit.userId },
            update: {},
          });
          const wallet = await tx.wallet.update({
            where: { userId: deposit.userId },
            data: { availableBalance: { increment: verifiedAmount! } },
          });
          await tx.ledgerEntry.create({
            data: {
              userId: deposit.userId, depositRequestId: deposit.id,
              reference: `deposit:${deposit.id}`, type: "DEPOSIT_CREDIT",
              amount: verifiedAmount!, balanceAfter: wallet.availableBalance,
              createdAt: now,
            },
          });
        }
        await tx.depositDecisionAudit.create({
          data: {
            depositId, adminId, decision: status,
            verifiedAmount: approving ? verifiedAmount : null,
            amountDifferenceConfirmed: amountDiffers,
            verificationNote, rejectionReason, createdAt: now,
          },
        });
        const reviewed = await tx.depositRequest.findUniqueOrThrow({
          where: { id: depositId }, include: depositReviewInclude,
        });
        return { deposit: reviewed, alreadyProcessed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2034") {
          if (attempt < 2) continue;
          throw new DepositError("A concurrent balance or review update is in progress. Retry safely.", 409);
        }
        if (error.code === "P2002") {
          throw new DepositError("This deposit already has a financial or audit record. No additional credit was applied.", 409);
        }
      }
      throw error;
    }
  }
  throw new DepositError("Please retry safely.", 409);
}
