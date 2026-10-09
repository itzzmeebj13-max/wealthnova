-- Keep the original disabled implementation as audit archives, not a second
-- public submission system. Never drop its receipts, decisions or ledger links.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'DepositRequest' AND column_name = 'receiptFileId')
  THEN
    IF EXISTS (SELECT 1 FROM "DepositRequest") THEN
      RAISE EXCEPTION 'Existing legacy deposit requests require explicit reconciliation before changing deposit implementations. No requests or receipts have been removed.';
    END IF;
    ALTER TABLE "DepositRequest" RENAME TO "ArchivedManualDeposit";
  END IF;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
    WHERE conrelid = to_regclass('"ArchivedManualDeposit"') AND conname LIKE 'DepositRequest_%'
  LOOP
    EXECUTE format('ALTER TABLE "ArchivedManualDeposit" RENAME CONSTRAINT %I TO %I',
      r.conname, replace(r.conname, 'DepositRequest_', 'ArchivedManualDeposit_'));
  END LOOP;
  FOR r IN SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'ArchivedManualDeposit' AND indexname LIKE 'DepositRequest_%'
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I',
      r.indexname, replace(r.indexname, 'DepositRequest_', 'ArchivedManualDeposit_'));
  END LOOP;
END $$;

DO $$ BEGIN CREATE TYPE "DepositStatus" AS ENUM ('PENDING_VERIFICATION', 'APPROVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DepositFilePurpose" AS ENUM ('RECEIPT', 'QR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LedgerBalanceBucket" AS ENUM ('AVAILABLE', 'RESERVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WithdrawalDecision" AS ENUM ('PROCESSING', 'COMPLETED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DepositImagePurpose" AS ENUM ('QR', 'RECEIPT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DepositRequestStatus" AS ENUM ('PENDING_VERIFICATION', 'APPROVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DepositDecisionType" AS ENUM ('APPROVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_RESERVE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_HOLD';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_RELEASE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_UNHOLD';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_PAYOUT';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_FEE';

ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "activeWithdrawalId" TEXT;
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "reservedBalance" DECIMAL(16,2) NOT NULL DEFAULT 0;
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "balanceBucket" "LedgerBalanceBucket" NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "depositRequestId" TEXT;
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "withdrawalId" TEXT;
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "depositId" TEXT;

CREATE TABLE IF NOT EXISTS "DepositFile" (
  "id" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "purpose" "DepositFilePurpose" NOT NULL,
  "contentType" TEXT NOT NULL, "size" INTEGER NOT NULL, "stagingPath" TEXT NOT NULL,
  "objectPath" TEXT, "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "PaymentSettings" (
  "id" TEXT PRIMARY KEY DEFAULT 'gcash', "enabled" BOOLEAN NOT NULL DEFAULT false,
  "accountName" TEXT NOT NULL DEFAULT '', "accountNumber" TEXT NOT NULL DEFAULT '',
  "instructions" TEXT NOT NULL DEFAULT '', "qrFileId" TEXT, "updatedBy" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS "ArchivedManualDeposit" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "amount" DECIMAL(16,2) NOT NULL,
  "transactionReference" TEXT NOT NULL, "receiptFileId" TEXT NOT NULL,
  "status" "DepositStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION', "verifiedAmount" DECIMAL(16,2),
  "reason" TEXT NOT NULL DEFAULT '', "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "paymentDetails" JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS "WithdrawalRequest" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "requestedAmount" DECIMAL(16,2) NOT NULL,
  "feeAmount" DECIMAL(16,2) NOT NULL, "netAmount" DECIMAL(16,2) NOT NULL, "feeBasisPoints" INTEGER NOT NULL DEFAULT 500,
  "accountName" TEXT NOT NULL, "accountNumber" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING', "processingById" TEXT, "processedAt" TIMESTAMP(3),
  "reviewedById" TEXT, "reviewedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "payoutReference" TEXT,
  "verificationNote" TEXT, "rejectionReason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS "WithdrawalAudit" (
  "id" TEXT PRIMARY KEY, "withdrawalId" TEXT NOT NULL, "adminId" TEXT NOT NULL,
  "decision" "WithdrawalDecision" NOT NULL, "payoutReference" TEXT, "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "WithdrawalNotification" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "withdrawalId" TEXT NOT NULL,
  "status" "WithdrawalStatus" NOT NULL, "message" TEXT NOT NULL, "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "DepositImage" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "purpose" "DepositImagePurpose" NOT NULL,
  "objectPath" TEXT NOT NULL, "contentType" TEXT NOT NULL, "size" INTEGER NOT NULL, "digest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "DepositPaymentSettings" (
  "id" TEXT PRIMARY KEY DEFAULT 'gcash', "qrImageId" TEXT, "accountName" TEXT NOT NULL DEFAULT '',
  "accountNumber" TEXT NOT NULL DEFAULT '', "instructions" TEXT NOT NULL DEFAULT '',
  "minimumAmount" DECIMAL(16,2) NOT NULL DEFAULT 350, "accountDetailsConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "submissionsEnabled" BOOLEAN NOT NULL DEFAULT false, "version" INTEGER NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS "DepositRequest" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "amount" DECIMAL(16,2) NOT NULL,
  "transactionReference" TEXT NOT NULL, "receiptImageId" TEXT NOT NULL, "receiptDigest" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL, "status" "DepositRequestStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "accountName" TEXT NOT NULL, "accountNumber" TEXT NOT NULL, "settingsVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "reviewedById" TEXT, "reviewedAt" TIMESTAMP(3), "approvedAt" TIMESTAMP(3),
  "verifiedAmount" DECIMAL(16,2), "rejectionReason" TEXT
);
CREATE TABLE IF NOT EXISTS "DepositDecisionAudit" (
  "id" TEXT PRIMARY KEY, "depositId" TEXT NOT NULL, "adminId" TEXT NOT NULL,
  "decision" "DepositDecisionType" NOT NULL, "verifiedAmount" DECIMAL(16,2), "verificationNote" TEXT,
  "amountDifferenceConfirmed" BOOLEAN NOT NULL DEFAULT false, "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "DepositFile_stagingPath_key" ON "DepositFile"("stagingPath");
CREATE UNIQUE INDEX IF NOT EXISTS "DepositFile_objectPath_key" ON "DepositFile"("objectPath");
CREATE INDEX IF NOT EXISTS "DepositFile_ownerId_createdAt_idx" ON "DepositFile"("ownerId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ArchivedManualDeposit_transactionReference_key" ON "ArchivedManualDeposit"("transactionReference");
CREATE UNIQUE INDEX IF NOT EXISTS "ArchivedManualDeposit_receiptFileId_key" ON "ArchivedManualDeposit"("receiptFileId");
CREATE INDEX IF NOT EXISTS "ArchivedManualDeposit_userId_createdAt_idx" ON "ArchivedManualDeposit"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "ArchivedManualDeposit_status_createdAt_idx" ON "ArchivedManualDeposit"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Wallet_activeWithdrawalId_key" ON "Wallet"("activeWithdrawalId");
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_depositId_key" ON "LedgerEntry"("depositId");
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_depositRequestId_key" ON "LedgerEntry"("depositRequestId");
CREATE INDEX IF NOT EXISTS "LedgerEntry_withdrawalId_type_idx" ON "LedgerEntry"("withdrawalId", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_payoutReference_key" ON "WithdrawalRequest"("payoutReference");
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_userId_idempotencyKey_key" ON "WithdrawalRequest"("userId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_userId_createdAt_idx" ON "WithdrawalRequest"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_status_createdAt_idx" ON "WithdrawalRequest"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalAudit_withdrawalId_decision_key" ON "WithdrawalAudit"("withdrawalId", "decision");
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalNotification_withdrawalId_status_key" ON "WithdrawalNotification"("withdrawalId", "status");
CREATE INDEX IF NOT EXISTS "WithdrawalNotification_userId_readAt_idx" ON "WithdrawalNotification"("userId", "readAt");
CREATE UNIQUE INDEX IF NOT EXISTS "DepositImage_objectPath_key" ON "DepositImage"("objectPath");
CREATE INDEX IF NOT EXISTS "DepositImage_userId_createdAt_idx" ON "DepositImage"("userId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "DepositRequest_transactionReference_key" ON "DepositRequest"("transactionReference");
CREATE UNIQUE INDEX IF NOT EXISTS "DepositRequest_receiptImageId_key" ON "DepositRequest"("receiptImageId");
CREATE UNIQUE INDEX IF NOT EXISTS "DepositRequest_receiptDigest_key" ON "DepositRequest"("receiptDigest");
CREATE UNIQUE INDEX IF NOT EXISTS "DepositRequest_userId_idempotencyKey_key" ON "DepositRequest"("userId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "DepositRequest_userId_createdAt_idx" ON "DepositRequest"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "DepositRequest_status_createdAt_idx" ON "DepositRequest"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "DepositDecisionAudit_depositId_key" ON "DepositDecisionAudit"("depositId");
CREATE INDEX IF NOT EXISTS "DepositDecisionAudit_adminId_createdAt_idx" ON "DepositDecisionAudit"("adminId", "createdAt");

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('DepositFile', 'ownerId', 'User', 'DepositFile_ownerId_fkey'),
    ('PaymentSettings', 'qrFileId', 'DepositFile', 'PaymentSettings_qrFileId_fkey'),
    ('PaymentSettings', 'updatedBy', 'User', 'PaymentSettings_updatedBy_fkey'),
    ('ArchivedManualDeposit', 'userId', 'User', 'ArchivedManualDeposit_userId_fkey'),
    ('ArchivedManualDeposit', 'reviewedBy', 'User', 'ArchivedManualDeposit_reviewedBy_fkey'),
    ('ArchivedManualDeposit', 'receiptFileId', 'DepositFile', 'ArchivedManualDeposit_receiptFileId_fkey'),
    ('LedgerEntry', 'depositId', 'ArchivedManualDeposit', 'LedgerEntry_depositId_fkey'),
    ('LedgerEntry', 'depositRequestId', 'DepositRequest', 'LedgerEntry_depositRequestId_fkey'),
    ('LedgerEntry', 'withdrawalId', 'WithdrawalRequest', 'LedgerEntry_withdrawalId_fkey'),
    ('WithdrawalRequest', 'userId', 'User', 'WithdrawalRequest_userId_fkey'),
    ('WithdrawalRequest', 'processingById', 'User', 'WithdrawalRequest_processingById_fkey'),
    ('WithdrawalRequest', 'reviewedById', 'User', 'WithdrawalRequest_reviewedById_fkey'),
    ('WithdrawalAudit', 'withdrawalId', 'WithdrawalRequest', 'WithdrawalAudit_withdrawalId_fkey'),
    ('WithdrawalAudit', 'adminId', 'User', 'WithdrawalAudit_adminId_fkey'),
    ('WithdrawalNotification', 'userId', 'User', 'WithdrawalNotification_userId_fkey'),
    ('WithdrawalNotification', 'withdrawalId', 'WithdrawalRequest', 'WithdrawalNotification_withdrawalId_fkey'),
    ('DepositImage', 'userId', 'User', 'DepositImage_userId_fkey'),
    ('DepositPaymentSettings', 'qrImageId', 'DepositImage', 'DepositPaymentSettings_qrImageId_fkey'),
    ('DepositRequest', 'userId', 'User', 'DepositRequest_userId_fkey'),
    ('DepositRequest', 'receiptImageId', 'DepositImage', 'DepositRequest_receiptImageId_fkey'),
    ('DepositRequest', 'reviewedById', 'User', 'DepositRequest_reviewedById_fkey'),
    ('DepositDecisionAudit', 'depositId', 'DepositRequest', 'DepositDecisionAudit_depositId_fkey'),
    ('DepositDecisionAudit', 'adminId', 'User', 'DepositDecisionAudit_adminId_fkey')
  ) AS f(tbl, col, target, name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(format('%I', r.tbl)) AND conname = r.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE RESTRICT ON UPDATE CASCADE',
        r.tbl, r.name, r.col, r.target);
    END IF;
  END LOOP;
END $$;

-- Application checks are supplemented by durable money/decision checks.
ALTER TABLE "DepositRequest" ADD CONSTRAINT "deposit_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "DepositRequest" ADD CONSTRAINT "deposit_verified_amount_positive"
  CHECK ("verifiedAmount" IS NULL OR "verifiedAmount" > 0);
ALTER TABLE "DepositRequest" ADD CONSTRAINT "deposit_decision_coherent" CHECK (
  ("status" = 'PENDING_VERIFICATION' AND "reviewedById" IS NULL AND "reviewedAt" IS NULL AND "approvedAt" IS NULL AND "verifiedAmount" IS NULL AND "rejectionReason" IS NULL)
  OR ("status" = 'APPROVED' AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "approvedAt" IS NOT NULL AND "verifiedAmount" IS NOT NULL AND "verifiedAmount" > 0 AND "rejectionReason" IS NULL)
  OR ("status" = 'REJECTED' AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "approvedAt" IS NULL AND "verifiedAmount" IS NULL AND "rejectionReason" IS NOT NULL AND length(trim("rejectionReason")) >= 5)
);
