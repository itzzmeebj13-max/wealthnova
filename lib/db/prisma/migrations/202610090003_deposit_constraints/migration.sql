-- Defense in depth for positive money and audited final decisions.
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_amount_positive"
CHECK ("amount" > 0 AND "amount" <= 99999999.99);
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_decision_audited"
CHECK (
  ("status" = 'PENDING_VERIFICATION' AND "verifiedAmount" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL)
  OR ("status" = 'APPROVED' AND "verifiedAmount" IS NOT NULL AND "verifiedAmount" > 0 AND "verifiedAmount" <= 99999999.99 AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL)
  OR ("status" = 'REJECTED' AND "verifiedAmount" IS NULL AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL AND length(trim("reason")) > 0)
);
