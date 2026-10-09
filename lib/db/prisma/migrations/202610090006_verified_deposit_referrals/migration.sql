-- AlterTable
ALTER TABLE "ReferralCommission" ADD COLUMN     "depositId" TEXT,
ALTER COLUMN "investmentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ReferralRateVersion" ADD COLUMN     "sourceType" TEXT NOT NULL DEFAULT 'INVESTMENT';

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCommission_depositId_tier_key" ON "ReferralCommission"("depositId", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCommission_depositId_beneficiaryId_key" ON "ReferralCommission"("depositId", "beneficiaryId");

-- AddForeignKey
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "DepositRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_one_source_check"
CHECK (("investmentId" IS NULL) <> ("depositId" IS NULL));
ALTER TABLE "ReferralRateVersion" ADD CONSTRAINT "ReferralRateVersion_sourceType_check"
CHECK ("sourceType" IN ('INVESTMENT','DEPOSIT'));
