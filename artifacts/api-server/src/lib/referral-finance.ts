import { prisma } from "@workspace/db";
import { Prisma } from "@prisma/client";
import { DepositError } from "./private-images";
import { normalizeTransactionReference } from "./deposits";
import { FUND_ID, commissionInclude, requireActiveAdmin, validateRates } from "./referral-data";

export type ReferralDatabase = Pick<typeof prisma, "referralCommission" | "companyCapital" | "user" | "referralNotification" | "referralRateVersion" | "commissionAudit"> & {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel: Prisma.TransactionIsolationLevel }): Promise<T>;
};
export async function referralTransaction<T>(db: ReferralDatabase, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(e.code)) {
        if (attempt < 2) continue;
        throw new DepositError("This record changed or the payment reference/receipt has already been used. Reload and try again.", 409);
      }
      throw e;
    }
  }
  throw new DepositError("Please reload and try again.", 409);
}

async function fundEntry(tx: Prisma.TransactionClient, input: {
  reference: string; type: Prisma.CompanyFundEntryCreateInput["type"]; balanceBucket: "AVAILABLE" | "RESERVED";
  amount: Prisma.Decimal; commissionId?: string; capitalId?: string; withdrawalId?: string;
}) {
  const fund = await tx.commissionFund.findUniqueOrThrow({ where: { id: FUND_ID } });
  return tx.companyFundEntry.create({ data: {
    ...input, balanceAfter: input.balanceBucket === "AVAILABLE" ? fund.availableBalance : fund.reservedBalance,
  } });
}

// Read-only integration with the existing withdrawal system. Only actual,
// completed, audited payouts with matching financial ledger entries qualify.
export async function collectVerifiedFees(tx: Prisma.TransactionClient) {
  const completed = await tx.withdrawalRequest.findMany({
    where: { status: "COMPLETED", companyFundEntries: { none: { type: "VERIFIED_FEE" } } },
    include: { ledgerEntries: true, audits: true }, take: 100,
  });
  for (const w of completed) {
    if (!w.completedAt || !w.reviewedById || !w.payoutReference || !w.verificationNote || !w.feeAmount.gt(0) ||
      !w.audits.some(a => a.decision === "COMPLETED" && a.payoutReference === w.payoutReference) ||
      !w.ledgerEntries.some(e => e.type === "WITHDRAWAL_FEE" && e.balanceBucket === "RESERVED" && e.amount.equals(w.feeAmount.negated())) ||
      !w.ledgerEntries.some(e => e.type === "WITHDRAWAL_PAYOUT" && e.balanceBucket === "RESERVED" && e.amount.equals(w.netAmount.negated())) ||
      !w.netAmount.add(w.feeAmount).equals(w.requestedAmount)) continue;
    await tx.commissionFund.upsert({ where: { id: FUND_ID }, create: { id: FUND_ID }, update: {} });
    await tx.commissionFund.update({ where: { id: FUND_ID }, data: { availableBalance: { increment: w.feeAmount } } });
    await fundEntry(tx, { reference: `verified-fee:${w.id}`, type: "VERIFIED_FEE", balanceBucket: "AVAILABLE", amount: w.feeAmount, withdrawalId: w.id });
  }
}

export async function changeReferralRates(adminId: string, input: {
  tier1: string; tier2: string; tier3: string; expectedVersion: number; reason: string;
}, db: ReferralDatabase = prisma) {
  const points = validateRates([input.tier1, input.tier2, input.tier3]);
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 1000) throw new DepositError("Provide a rate-change reason of 5–1000 characters.");
  return referralTransaction(db, async tx => {
    await requireActiveAdmin(tx, adminId);
    const latest = await tx.referralRateVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
    if (latest.version !== input.expectedVersion) throw new DepositError("Rates were changed by another administrator. Reload before saving.", 409);
    return tx.referralRateVersion.create({ data: {
      version: latest.version + 1, tier1BasisPoints: points[0], tier2BasisPoints: points[1], tier3BasisPoints: points[2],
      effectiveFrom: new Date(), changedById: adminId, changeReason: reason,
    } });
  });
}

type CapitalInput = { amount: string; transactionReference: string; receiptImageId: string; verificationNote: string; confirmedCapitalReceived: boolean; idempotencyKey: string };
export async function verifyCapital(adminId: string, input: CapitalInput, db: ReferralDatabase = prisma) {
  if (input.confirmedCapitalReceived !== true) throw new DepositError("Independently confirm actual separate company capital was received.");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(input.amount)) throw new DepositError("Enter a valid PHP amount with at most two decimal places.");
  const amount = new Prisma.Decimal(input.amount);
  if (!amount.gt(0)) throw new DepositError("Company capital must be a positive amount.");
  const reference = normalizeTransactionReference(input.transactionReference);
  const note = input.verificationNote.trim();
  if (note.length < 10 || note.length > 1000) throw new DepositError("Provide an independent verification note of 10–1000 characters.");
  return referralTransaction(db, async tx => {
    await requireActiveAdmin(tx, adminId);
    const prior = await tx.companyCapital.findUnique({ where: { verifiedById_idempotencyKey: { verifiedById: adminId, idempotencyKey: input.idempotencyKey } } });
    if (prior) {
      if (!prior.amount.equals(amount) || prior.transactionReference !== reference || prior.receiptImageId !== input.receiptImageId || prior.verificationNote !== note) {
        throw new DepositError("This request key was already used for different company funding.", 409);
      }
      return prior;
    }
    const image = await tx.depositImage.findUnique({ where: { id: input.receiptImageId } });
    if (!image || image.userId !== adminId || image.purpose !== "CAPITAL_RECEIPT") throw new DepositError("Upload your own valid private company-capital receipt.");
    // Legacy deposits are checked too, in case installation was interrupted.
    const memberClaim = await tx.depositRequest.findFirst({ where: { OR: [{ transactionReference: reference }, { receiptDigest: image.digest }] } });
    if (memberClaim) throw new DepositError("A member deposit reference or receipt cannot fund the company commission reserve.", 409);
    const capital = await tx.companyCapital.create({ data: {
      amount, transactionReference: reference, receiptImageId: image.id, receiptDigest: image.digest,
      verifiedById: adminId, verificationNote: note, idempotencyKey: input.idempotencyKey,
    } });
    await tx.incomingPaymentClaim.create({ data: { reference, receiptDigest: image.digest, sourceId: capital.id, kind: "CAPITAL" } });
    await tx.commissionFund.upsert({ where: { id: FUND_ID }, create: { id: FUND_ID }, update: {} });
    await tx.commissionFund.update({ where: { id: FUND_ID }, data: { availableBalance: { increment: amount } } });
    await fundEntry(tx, { reference: `capital:${capital.id}`, type: "VERIFIED_CAPITAL", balanceBucket: "AVAILABLE", amount, capitalId: capital.id });
    return capital;
  });
}

async function ensureEligible(tx: Prisma.TransactionClient, id: string) {
  const c = await tx.referralCommission.findUniqueOrThrow({ where: { id }, include: commissionInclude });
  const source = c.sourceLedger;
  if (c.beneficiaryId === c.sourceUserId || c.beneficiary.status !== "ACTIVE" ||
    !["ACTIVE", "COMPLETED"].includes(c.investment.status) || source.type !== "INVESTMENT_DEBIT" ||
    source.userId !== c.sourceUserId || source.investmentId !== c.investmentId ||
    !source.amount.equals(c.basisAmount) || !c.investment.principalAmount.equals(c.basisAmount) ||
    !c.basisAmount.mul(c.rateBasisPoints).div(10000).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).equals(c.amount)) {
    throw new DepositError("This commission's beneficiary or verified source transaction is no longer eligible.", 409);
  }
  return c;
}

export async function decideCommission(adminId: string, id: string, decision: "APPROVED" | "REJECTED" | "PAID",
  input: { note: string; confirmed: boolean }, db: ReferralDatabase = prisma) {
  const note = input.note.trim();
  if (input.confirmed !== true || note.length < 5 || note.length > 1000) throw new DepositError("Confirm the decision and provide a note of 5–1000 characters.");
  return referralTransaction(db, async tx => {
    await requireActiveAdmin(tx, adminId);
    let c = await tx.referralCommission.findUnique({ where: { id }, include: commissionInclude });
    if (!c) throw new DepositError("Commission not found.", 404);
    if (c.status === decision) return c; // Financially idempotent; first audit and notification stay unchanged.
    if (c.status === "PAID" || c.status === "REJECTED") throw new DepositError("This commission already has a final decision.", 409);
    if (decision !== "REJECTED") c = await ensureEligible(tx, id);
    await tx.commissionFund.upsert({ where: { id: FUND_ID }, create: { id: FUND_ID }, update: {} });
    if (decision === "APPROVED") {
      if (c.status !== "PENDING") throw new DepositError("Only Pending commissions can be approved.", 409);
      await collectVerifiedFees(tx);
      const held = await tx.commissionFund.updateMany({ where: { id: FUND_ID, availableBalance: { gte: c.amount } },
        data: { availableBalance: { decrement: c.amount }, reservedBalance: { increment: c.amount } } });
      if (held.count !== 1) throw new DepositError("Insufficient verified company reserve. Commission remains Pending; no wallet credit was created.", 409);
      await fundEntry(tx, { reference: `commission:${id}:reserve`, type: "COMMISSION_RESERVE", balanceBucket: "AVAILABLE", amount: c.amount.negated(), commissionId: id });
      await fundEntry(tx, { reference: `commission:${id}:hold`, type: "COMMISSION_HOLD", balanceBucket: "RESERVED", amount: c.amount, commissionId: id });
    } else if (decision === "PAID") {
      if (c.status !== "APPROVED") throw new DepositError("Only Approved, fully funded commissions can be credited to a wallet.", 409);
      const hold = await tx.companyFundEntry.findUnique({ where: { reference: `commission:${id}:hold` } });
      if (!hold || !hold.amount.equals(c.amount)) throw new DepositError("Commission funding reservation is missing.", 409);
      const spent = await tx.commissionFund.updateMany({ where: { id: FUND_ID, reservedBalance: { gte: c.amount } },
        data: { reservedBalance: { decrement: c.amount } } });
      if (spent.count !== 1) throw new DepositError("Verified reserved company funding is insufficient.", 409);
      const wallet = await tx.wallet.upsert({ where: { userId: c.beneficiaryId },
        create: { userId: c.beneficiaryId, availableBalance: c.amount }, update: { availableBalance: { increment: c.amount } } });
      await tx.ledgerEntry.create({ data: { userId: c.beneficiaryId, reference: `commission:${id}:paid`,
        type: "REFERRAL_COMMISSION_CREDIT", referralCommissionId: id, amount: c.amount, balanceAfter: wallet.availableBalance, balanceBucket: "AVAILABLE" } });
      await fundEntry(tx, { reference: `commission:${id}:transfer`, type: "COMMISSION_TRANSFER", balanceBucket: "RESERVED", amount: c.amount.negated(), commissionId: id });
    } else if (c.status === "APPROVED") {
      const hold = await tx.companyFundEntry.findUnique({ where: { reference: `commission:${id}:hold` } });
      if (!hold || !hold.amount.equals(c.amount)) throw new DepositError("Commission funding reservation is missing.", 409);
      const released = await tx.commissionFund.updateMany({ where: { id: FUND_ID, reservedBalance: { gte: c.amount } },
        data: { reservedBalance: { decrement: c.amount }, availableBalance: { increment: c.amount } } });
      if (released.count !== 1) throw new DepositError("Commission funding reservation needs reconciliation.", 409);
      await fundEntry(tx, { reference: `commission:${id}:unhold`, type: "COMMISSION_UNHOLD", balanceBucket: "RESERVED", amount: c.amount.negated(), commissionId: id });
      await fundEntry(tx, { reference: `commission:${id}:release`, type: "COMMISSION_RELEASE", balanceBucket: "AVAILABLE", amount: c.amount, commissionId: id });
    }
    const changed = await tx.referralCommission.updateMany({ where: { id, status: c.status }, data: {
      status: decision, ...(decision === "APPROVED" ? { approvedAt: new Date() } :
        decision === "PAID" ? { paidAt: new Date() } : { rejectedAt: new Date(), rejectionReason: note }),
    } });
    if (changed.count !== 1) throw new DepositError("Commission changed during review. Reload.", 409);
    await tx.commissionAudit.create({ data: { commissionId: id, adminId, decision, note } });
    const message = decision === "PAID" ? `Your commission of PHP ${c.amount.toFixed(2)} was paid into your verified wallet. This is not a GCash payout.` :
      decision === "APPROVED" ? "Your commission was approved with verified company funds reserved. It is not spendable until credited to your wallet." :
      `Your commission was rejected. Reason: ${note}`;
    await tx.referralNotification.create({ data: { userId: c.beneficiaryId, eventKey: `commission:${id}:${decision}`, type: `COMMISSION_${decision}`, message, commissionId: id } });
    return tx.referralCommission.findUniqueOrThrow({ where: { id }, include: commissionInclude });
  });
}

export async function getFundSummary(db: ReferralDatabase = prisma) {
  return referralTransaction(db, async tx => {
    await collectVerifiedFees(tx);
    const fund = await tx.commissionFund.findUniqueOrThrow({ where: { id: FUND_ID } });
    const totals = await tx.companyFundEntry.groupBy({ by: ["type"], _sum: { amount: true } });
    const total = (type: string) => totals.find(t => t.type === type)?._sum.amount ?? new Prisma.Decimal(0);
    const recentCapital = await tx.companyCapital.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    const entries = await tx.companyFundEntry.findMany({ orderBy: { createdAt: "desc" }, take: 40 });
    return {
      availableBalance: fund.availableBalance.toFixed(2), reservedBalance: fund.reservedBalance.toFixed(2),
      totalCapital: total("VERIFIED_CAPITAL").toFixed(2), totalFees: total("VERIFIED_FEE").toFixed(2),
      totalPaid: total("COMMISSION_TRANSFER").negated().toFixed(2),
      recentCapital: recentCapital.map(mapCapital),
      entries: entries.map(e => ({ ...e, amount: e.amount.toFixed(2), balanceAfter: e.balanceAfter.toFixed(2), createdAt: e.createdAt.toISOString() })),
    };
  });
}
export function mapCapital(c: Prisma.CompanyCapitalGetPayload<{}>) {
  return { id: c.id, amount: c.amount.toFixed(2), transactionReference: c.transactionReference,
    receiptImageId: c.receiptImageId, verifiedById: c.verifiedById, verificationNote: c.verificationNote, createdAt: c.createdAt.toISOString() };
}
