-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING_VERIFICATION', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DepositFilePurpose" AS ENUM ('RECEIPT', 'QR');

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN     "depositId" TEXT;

-- CreateTable
CREATE TABLE "DepositFile" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "purpose" "DepositFilePurpose" NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "stagingPath" TEXT NOT NULL,
    "objectPath" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSettings" (
    "id" TEXT NOT NULL DEFAULT 'gcash',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "accountName" TEXT NOT NULL DEFAULT '',
    "accountNumber" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "qrFileId" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "transactionReference" TEXT NOT NULL,
    "receiptFileId" TEXT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verifiedAmount" DECIMAL(16,2),
    "reason" TEXT NOT NULL DEFAULT '',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentDetails" JSONB NOT NULL,

    CONSTRAINT "DepositRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepositFile_stagingPath_key" ON "DepositFile"("stagingPath");

-- CreateIndex
CREATE UNIQUE INDEX "DepositFile_objectPath_key" ON "DepositFile"("objectPath");

-- CreateIndex
CREATE INDEX "DepositFile_ownerId_createdAt_idx" ON "DepositFile"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DepositRequest_transactionReference_key" ON "DepositRequest"("transactionReference");

-- CreateIndex
CREATE UNIQUE INDEX "DepositRequest_receiptFileId_key" ON "DepositRequest"("receiptFileId");

-- CreateIndex
CREATE INDEX "DepositRequest_userId_createdAt_idx" ON "DepositRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DepositRequest_status_createdAt_idx" ON "DepositRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_depositId_key" ON "LedgerEntry"("depositId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "DepositRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositFile" ADD CONSTRAINT "DepositFile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSettings" ADD CONSTRAINT "PaymentSettings_qrFileId_fkey" FOREIGN KEY ("qrFileId") REFERENCES "DepositFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSettings" ADD CONSTRAINT "PaymentSettings_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_receiptFileId_fkey" FOREIGN KEY ("receiptFileId") REFERENCES "DepositFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
