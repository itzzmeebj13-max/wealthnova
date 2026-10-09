import { prisma } from "@workspace/db";
import { Prisma } from "@prisma/client";
import { DepositError } from "./private-images";

export const FUND_ID = "operating";
export const commissionInclude = {
  beneficiary: true, sourceUser: true, investment: { include: { plan: true } },
  deposit: { include: { decisionAudit: true } },
  sourceLedger: true, rateVersion: true,
} satisfies Prisma.ReferralCommissionInclude;
export type CommissionRecord = Prisma.ReferralCommissionGetPayload<{ include: typeof commissionInclude }>;

export function mapCommission(c: CommissionRecord, admin = false) {
  return {
    id: c.id, beneficiaryId: c.beneficiaryId,
    beneficiaryAccount: admin ? c.beneficiary.mobileNumber : `••••${c.beneficiary.mobileNumber.slice(-4)}`,
    sourceAccount: admin ? c.sourceUser.mobileNumber : `••••${c.sourceUser.mobileNumber.slice(-4)}`,
    investmentId: c.investmentId, depositId: c.depositId, sourceType: c.depositId ? "DEPOSIT" : "INVESTMENT",
    sourceTransactionReference: c.sourceTransactionReference,
    rateVersion: c.rateVersion.version, planName: c.investment?.plan.name ?? "Verified deposit",
    tier: c.tier, ratePercent: c.rateBasisPoints / 100,
    basisAmount: c.basisAmount.toFixed(2), amount: c.amount.toFixed(2), status: c.status,
    rejectionReason: c.rejectionReason, approvedAt: c.approvedAt?.toISOString() ?? null,
    paidAt: c.paidAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
  };
}

export async function requireActiveAdmin(tx: Prisma.TransactionClient, id: string) {
  const actor = await tx.user.findUnique({ where: { id } });
  if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE") {
    throw new DepositError("Only authorized active administrators can perform this action.", 403);
  }
}

export function validateRates(values: string[]) {
  const points = values.map(value => {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) {
      throw new DepositError("Rates must be percentages between 0 and 100 with at most two decimal places.");
    }
    const percent = new Prisma.Decimal(value);
    if (percent.gt(100)) throw new DepositError("Each commission rate must be between 0% and 100%.");
    return percent.mul(100).toNumber();
  });
  if (points.reduce((sum, n) => sum + n, 0) > 10000) {
    throw new DepositError("The three commission rates must total no more than 100%.");
  }
  return points;
}

type ReferralReads = Pick<Prisma.TransactionClient, "user" | "referralRateVersion" | "referralCommission" | "depositRequest">;
export async function getReferralOverview(userId: string, db: ReferralReads = prisma) {
  const level1 = await db.user.findMany({ where: { referredBy: userId, id: { not: userId } }, select: { id: true } });
  const seen = [userId, ...level1.map(u => u.id)];
  const level2 = await db.user.findMany({
    where: { referredBy: { in: level1.map(u => u.id) }, id: { notIn: seen } }, select: { id: true },
  });
  seen.push(...level2.map(u => u.id));
  const thirdLevel = await db.user.findMany({ where: {
    referredBy: { in: level2.map(u => u.id) }, id: { notIn: seen },
  }, select: { id: true } });
  const invitedIds = [...seen.slice(1), ...thirdLevel.map(u => u.id)];
  const deposits = await db.depositRequest.findMany({ where: { userId: { in: invitedIds }, status: "APPROVED" },
    include: { ledgerEntry: true, decisionAudit: true } });
  const qualified = new Set(deposits.filter(d => d.verifiedAmount?.gt(0) && d.approvedAt &&
    d.ledgerEntry?.type === "DEPOSIT_CREDIT" && d.ledgerEntry.userId === d.userId &&
    d.ledgerEntry.amount.equals(d.verifiedAmount) && d.decisionAudit?.decision === "APPROVED" &&
    d.decisionAudit.adminId === d.reviewedById && d.decisionAudit.verifiedAmount?.equals(d.verifiedAmount) &&
    (d.decisionAudit.verificationNote?.trim().length ?? 0) >= 10)
    .map(d => d.userId)).size;
  const rate = await db.referralRateVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
  const groups = await db.referralCommission.groupBy({
    by: ["status"], where: { beneficiaryId: userId }, _sum: { amount: true },
  });
  const sum = (status: string) => groups.find(g => g.status === status)?._sum.amount?.toFixed(2) ?? "0.00";
  return {
    referralCount: level1.length, tier1Count: level1.length, tier2Count: level2.length, tier3Count: thirdLevel.length,
    totalInvitedUsers: invitedIds.length, totalQualifiedReferrals: qualified, totalCommissionsEarned: sum("PAID"),
    rates: [rate.tier1BasisPoints, rate.tier2BasisPoints, rate.tier3BasisPoints].map((p, i) => ({ tier: i + 1, percent: p / 100 })),
    commissionTotals: {
      total: groups.reduce((total, g) => total.add(g._sum.amount ?? 0), new Prisma.Decimal(0)).toFixed(2),
      pending: sum("PENDING"), approved: sum("APPROVED"), rejected: sum("REJECTED"), paid: sum("PAID"),
    },
  };
}

export async function getReferralRateSettings(db: ReferralReads = prisma) {
  const history = await db.referralRateVersion.findMany({ orderBy: { version: "desc" }, take: 100, include: { changedBy: true } });
  const versions = history.map(r => ({
    version: r.version, tier1: r.tier1BasisPoints / 100, tier2: r.tier2BasisPoints / 100, tier3: r.tier3BasisPoints / 100,
    changedById: r.changedById, changedByAccount: r.changedBy?.mobileNumber ?? null,
    changeReason: r.changeReason, createdAt: r.createdAt.toISOString(),
  }));
  const [totalUsers, referralRelationships, totalCommissions] = await Promise.all([
    db.user.count({ where: { status: { not: "INVITE_ONLY" } } }),
    db.user.count({ where: { referredBy: { not: null } } }),
    db.referralCommission.count(),
  ]);
  return { current: versions[0], history: versions, totalUsers, referralRelationships, totalCommissions };
}
