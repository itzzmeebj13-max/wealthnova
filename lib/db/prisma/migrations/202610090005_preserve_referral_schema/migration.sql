-- Preserve incoming referral/company-fund models in the migration history.
-- Already-existing main-branch tables, balances and rate snapshots are untouched.
DO $$ BEGIN CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CompanyFundEntryType" AS ENUM ('VERIFIED_CAPITAL', 'VERIFIED_FEE', 'COMMISSION_RESERVE', 'COMMISSION_HOLD', 'COMMISSION_RELEASE', 'COMMISSION_UNHOLD', 'COMMISSION_TRANSFER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'REFERRAL_COMMISSION_CREDIT';
ALTER TYPE "DepositImagePurpose" ADD VALUE IF NOT EXISTS 'CAPITAL_RECEIPT';
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "referralCommissionId" TEXT;

CREATE TABLE IF NOT EXISTS "ReferralRateVersion" (
  "id" TEXT PRIMARY KEY, "version" INTEGER NOT NULL, "tier1BasisPoints" INTEGER NOT NULL,
  "tier2BasisPoints" INTEGER NOT NULL, "tier3BasisPoints" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL, "changedById" TEXT, "changeReason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CommissionFund" (
  "id" TEXT PRIMARY KEY, "availableBalance" DECIMAL(16,2) NOT NULL DEFAULT 0,
  "reservedBalance" DECIMAL(16,2) NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS "ReferralCommission" (
  "id" TEXT PRIMARY KEY, "beneficiaryId" TEXT NOT NULL, "sourceUserId" TEXT NOT NULL,
  "investmentId" TEXT NOT NULL, "sourceLedgerId" TEXT NOT NULL,
  "sourceTransactionReference" TEXT NOT NULL, "rateVersionId" TEXT NOT NULL,
  "tier" INTEGER NOT NULL, "rateBasisPoints" INTEGER NOT NULL,
  "basisAmount" DECIMAL(16,2) NOT NULL, "amount" DECIMAL(16,2) NOT NULL,
  "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
  "approvedAt" TIMESTAMP(3), "paidAt" TIMESTAMP(3), "rejectedAt" TIMESTAMP(3), "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS "CommissionAudit" (
  "id" TEXT PRIMARY KEY, "commissionId" TEXT NOT NULL, "adminId" TEXT NOT NULL,
  "decision" "CommissionStatus" NOT NULL, "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CompanyCapital" (
  "id" TEXT PRIMARY KEY, "amount" DECIMAL(16,2) NOT NULL, "transactionReference" TEXT NOT NULL,
  "receiptImageId" TEXT NOT NULL, "receiptDigest" TEXT NOT NULL, "verifiedById" TEXT NOT NULL,
  "verificationNote" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CompanyFundEntry" (
  "id" TEXT PRIMARY KEY, "reference" TEXT NOT NULL, "type" "CompanyFundEntryType" NOT NULL,
  "balanceBucket" "LedgerBalanceBucket" NOT NULL, "amount" DECIMAL(16,2) NOT NULL,
  "balanceAfter" DECIMAL(16,2) NOT NULL, "commissionId" TEXT, "capitalId" TEXT, "withdrawalId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "IncomingPaymentClaim" (
  "reference" TEXT PRIMARY KEY, "receiptDigest" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "ReferralNotification" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "eventKey" TEXT NOT NULL, "type" TEXT NOT NULL,
  "message" TEXT NOT NULL, "commissionId" TEXT, "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralRateVersion_version_key" ON "ReferralRateVersion"("version");
CREATE INDEX IF NOT EXISTS "ReferralCommission_beneficiaryId_status_createdAt_idx" ON "ReferralCommission"("beneficiaryId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "ReferralCommission_status_createdAt_idx" ON "ReferralCommission"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCommission_investmentId_tier_key" ON "ReferralCommission"("investmentId", "tier");
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCommission_investmentId_beneficiaryId_key" ON "ReferralCommission"("investmentId", "beneficiaryId");
CREATE UNIQUE INDEX IF NOT EXISTS "CommissionAudit_commissionId_decision_key" ON "CommissionAudit"("commissionId", "decision");
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyCapital_transactionReference_key" ON "CompanyCapital"("transactionReference");
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyCapital_receiptImageId_key" ON "CompanyCapital"("receiptImageId");
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyCapital_receiptDigest_key" ON "CompanyCapital"("receiptDigest");
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyCapital_verifiedById_idempotencyKey_key" ON "CompanyCapital"("verifiedById", "idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyFundEntry_reference_key" ON "CompanyFundEntry"("reference");
CREATE INDEX IF NOT EXISTS "CompanyFundEntry_type_createdAt_idx" ON "CompanyFundEntry"("type", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "IncomingPaymentClaim_receiptDigest_key" ON "IncomingPaymentClaim"("receiptDigest");
CREATE UNIQUE INDEX IF NOT EXISTS "IncomingPaymentClaim_sourceId_key" ON "IncomingPaymentClaim"("sourceId");
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralNotification_eventKey_key" ON "ReferralNotification"("eventKey");
CREATE INDEX IF NOT EXISTS "ReferralNotification_userId_readAt_createdAt_idx" ON "ReferralNotification"("userId", "readAt", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_referralCommissionId_key" ON "LedgerEntry"("referralCommissionId");
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('LedgerEntry', 'referralCommissionId', 'ReferralCommission', 'LedgerEntry_referralCommissionId_fkey'),
    ('ReferralRateVersion', 'changedById', 'User', 'ReferralRateVersion_changedById_fkey'),
    ('ReferralCommission', 'beneficiaryId', 'User', 'ReferralCommission_beneficiaryId_fkey'),
    ('ReferralCommission', 'sourceUserId', 'User', 'ReferralCommission_sourceUserId_fkey'),
    ('ReferralCommission', 'investmentId', 'Investment', 'ReferralCommission_investmentId_fkey'),
    ('ReferralCommission', 'sourceLedgerId', 'LedgerEntry', 'ReferralCommission_sourceLedgerId_fkey'),
    ('ReferralCommission', 'rateVersionId', 'ReferralRateVersion', 'ReferralCommission_rateVersionId_fkey'),
    ('CommissionAudit', 'commissionId', 'ReferralCommission', 'CommissionAudit_commissionId_fkey'),
    ('CommissionAudit', 'adminId', 'User', 'CommissionAudit_adminId_fkey'),
    ('CompanyCapital', 'receiptImageId', 'DepositImage', 'CompanyCapital_receiptImageId_fkey'),
    ('CompanyCapital', 'verifiedById', 'User', 'CompanyCapital_verifiedById_fkey'),
    ('CompanyFundEntry', 'commissionId', 'ReferralCommission', 'CompanyFundEntry_commissionId_fkey'),
    ('CompanyFundEntry', 'capitalId', 'CompanyCapital', 'CompanyFundEntry_capitalId_fkey'),
    ('CompanyFundEntry', 'withdrawalId', 'WithdrawalRequest', 'CompanyFundEntry_withdrawalId_fkey'),
    ('ReferralNotification', 'userId', 'User', 'ReferralNotification_userId_fkey'),
    ('ReferralNotification', 'commissionId', 'ReferralCommission', 'ReferralNotification_commissionId_fkey')
  ) AS f(tbl, col, target, name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I', r.tbl)) AND conname = r.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE RESTRICT ON UPDATE CASCADE',
        r.tbl, r.name, r.col, r.target);
    END IF;
  END LOOP;
END $$;
