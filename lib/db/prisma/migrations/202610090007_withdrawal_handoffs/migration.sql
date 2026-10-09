CREATE TABLE "WithdrawalHandoff" (
  "id" TEXT NOT NULL,
  "withdrawalId" TEXT NOT NULL,
  "fromAdminId" TEXT NOT NULL,
  "toAdminId" TEXT NOT NULL,
  "payoutStatus" TEXT NOT NULL CHECK ("payoutStatus" IN ('NOT_SENT', 'SENT')),
  "payoutReference" TEXT,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WithdrawalHandoff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WithdrawalHandoff_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "WithdrawalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WithdrawalHandoff_fromAdminId_fkey" FOREIGN KEY ("fromAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WithdrawalHandoff_toAdminId_fkey" FOREIGN KEY ("toAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "WithdrawalHandoff_withdrawalId_createdAt_idx" ON "WithdrawalHandoff"("withdrawalId", "createdAt");
