-- Each "-- statement" separates one PostgreSQL statement for Prisma's installer.
INSERT INTO "ReferralRateVersion" ("id", "version", "tier1BasisPoints", "tier2BasisPoints", "tier3BasisPoints", "effectiveFrom", "changeReason", "createdAt")
VALUES ('referral-default-rates', 1, 2000, 300, 100, '1970-01-01', 'Initial default rates; baseline for verified purchases without a commission snapshot.', CURRENT_TIMESTAMP)
ON CONFLICT ("version") DO NOTHING;
-- statement
INSERT INTO "CommissionFund" ("id", "availableBalance", "reservedBalance", "updatedAt")
VALUES ('operating', 0, 0, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;
-- statement
CREATE OR REPLACE FUNCTION wealthnova_referral_relationship_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."referredBy" = NEW."id" THEN
    RAISE EXCEPTION 'Self referrals are not allowed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."referredBy" IS DISTINCT FROM OLD."referredBy" THEN
    RAISE EXCEPTION 'Original referrer cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
-- statement
DROP TRIGGER IF EXISTS wealthnova_referral_relationship_guard ON "User";
-- statement
CREATE TRIGGER wealthnova_referral_relationship_guard BEFORE INSERT OR UPDATE OF "referredBy" ON "User"
FOR EACH ROW EXECUTE FUNCTION wealthnova_referral_relationship_guard();
-- statement
CREATE OR REPLACE FUNCTION wealthnova_referral_registered() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."referredBy" IS NOT NULL AND NEW."status" <> 'INVITE_ONLY'
    AND EXISTS (SELECT 1 FROM "User" WHERE "id" = NEW."referredBy" AND "status" = 'ACTIVE') THEN
    INSERT INTO "ReferralNotification" ("id", "userId", "eventKey", "type", "message", "createdAt")
    VALUES (gen_random_uuid()::text, NEW."referredBy", 'registration:' || NEW."id", 'REGISTRATION',
      'A member successfully registered using your referral code.', NEW."createdAt")
    ON CONFLICT ("eventKey") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
-- statement
DROP TRIGGER IF EXISTS wealthnova_referral_registered ON "User";
-- statement
CREATE TRIGGER wealthnova_referral_registered AFTER INSERT ON "User"
FOR EACH ROW EXECUTE FUNCTION wealthnova_referral_registered();
-- statement
INSERT INTO "ReferralNotification" ("id", "userId", "eventKey", "type", "message", "createdAt")
SELECT gen_random_uuid()::text, child."referredBy", 'registration:' || child."id", 'REGISTRATION',
  'A member successfully registered using your referral code.', child."createdAt"
FROM "User" child JOIN "User" parent ON parent."id" = child."referredBy"
WHERE parent."status" = 'ACTIVE' AND child."status" <> 'INVITE_ONLY'
ON CONFLICT ("eventKey") DO NOTHING;
-- statement
CREATE OR REPLACE FUNCTION wealthnova_generate_referral_commissions(source_investment text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  source_record record;
  source_entry record;
  rate_record record;
  parent_record record;
  parent_id text;
  visited text[];
  tier_number integer;
  basis_points integer;
  reward numeric(16,2);
  commission_id text;
BEGIN
  SELECT i.*, u."referredBy" INTO source_record
    FROM "Investment" i JOIN "User" u ON u."id" = i."userId" WHERE i."id" = source_investment;
  IF NOT FOUND OR source_record."status" NOT IN ('ACTIVE', 'COMPLETED') THEN RETURN; END IF;
  SELECT * INTO source_entry FROM "LedgerEntry"
    WHERE "investmentId" = source_investment AND "type" = 'INVESTMENT_DEBIT'
      AND "userId" = source_record."userId" AND "amount" = source_record."principalAmount"
    ORDER BY "createdAt", "id" LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO rate_record FROM "ReferralRateVersion"
    WHERE "effectiveFrom" <= source_record."startDate" ORDER BY "effectiveFrom" DESC, "version" DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Referral rate baseline is missing'; END IF;
  parent_id := source_record."referredBy";
  visited := ARRAY[source_record."userId"];
  FOR tier_number IN 1..3 LOOP
    EXIT WHEN parent_id IS NULL;
    IF parent_id = ANY(visited) THEN RAISE EXCEPTION 'Referral cycle detected' USING ERRCODE = '23514'; END IF;
    visited := array_append(visited, parent_id);
    SELECT * INTO parent_record FROM "User" WHERE "id" = parent_id;
    EXIT WHEN NOT FOUND;
    basis_points := CASE tier_number WHEN 1 THEN rate_record."tier1BasisPoints"
      WHEN 2 THEN rate_record."tier2BasisPoints" ELSE rate_record."tier3BasisPoints" END;
    reward := round(source_record."principalAmount" * basis_points / 10000, 2);
    IF parent_record."status" = 'ACTIVE' AND reward > 0 THEN
      commission_id := NULL;
      INSERT INTO "ReferralCommission" ("id", "beneficiaryId", "sourceUserId", "investmentId",
        "sourceLedgerId", "sourceTransactionReference", "rateVersionId", "tier", "rateBasisPoints",
        "basisAmount", "amount", "status", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, parent_id, source_record."userId", source_investment,
        source_entry."id", source_entry."reference", rate_record."id", tier_number, basis_points,
        source_record."principalAmount", reward, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("investmentId", "tier") DO NOTHING RETURNING "id" INTO commission_id;
      IF commission_id IS NOT NULL THEN
        INSERT INTO "ReferralNotification" ("id", "userId", "eventKey", "type", "message", "createdAt")
        VALUES (gen_random_uuid()::text, parent_id, 'verified:' || source_investment || ':' || parent_id,
          'VERIFIED_TRANSACTION', 'An eligible verified investment purchase was recorded. This is not a promise of earnings.', CURRENT_TIMESTAMP)
        ON CONFLICT ("eventKey") DO NOTHING;
        INSERT INTO "ReferralNotification" ("id", "userId", "eventKey", "type", "message", "commissionId", "createdAt")
        VALUES (gen_random_uuid()::text, parent_id, 'commission:' || commission_id, 'COMMISSION_RECORDED',
          'A Tier ' || tier_number || ' commission of PHP ' || reward || ' was recorded as Pending. It is not spendable and requires verified funding and Admin approval.',
          commission_id, CURRENT_TIMESTAMP) ON CONFLICT ("eventKey") DO NOTHING;
      END IF;
    END IF;
    parent_id := parent_record."referredBy";
  END LOOP;
END;
$$;
-- statement
CREATE OR REPLACE FUNCTION wealthnova_referral_verified_investment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."type" = 'INVESTMENT_DEBIT' AND NEW."investmentId" IS NOT NULL THEN
    PERFORM wealthnova_generate_referral_commissions(NEW."investmentId");
  END IF;
  RETURN NEW;
END;
$$;
-- statement
DROP TRIGGER IF EXISTS wealthnova_referral_verified_investment ON "LedgerEntry";
-- statement
CREATE TRIGGER wealthnova_referral_verified_investment AFTER INSERT ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION wealthnova_referral_verified_investment();
-- statement
INSERT INTO "IncomingPaymentClaim" ("reference", "receiptDigest", "sourceId", "kind", "createdAt")
SELECT "transactionReference", "receiptDigest", "id", 'DEPOSIT', "createdAt" FROM "DepositRequest"
ON CONFLICT DO NOTHING;
-- statement
CREATE OR REPLACE FUNCTION wealthnova_claim_deposit_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "IncomingPaymentClaim" ("reference", "receiptDigest", "sourceId", "kind")
  VALUES (NEW."transactionReference", NEW."receiptDigest", NEW."id", 'DEPOSIT');
  RETURN NEW;
END;
$$;
-- statement
DROP TRIGGER IF EXISTS wealthnova_claim_deposit_evidence ON "DepositRequest";
-- statement
CREATE TRIGGER wealthnova_claim_deposit_evidence AFTER INSERT ON "DepositRequest"
FOR EACH ROW EXECUTE FUNCTION wealthnova_claim_deposit_evidence();
-- statement
CREATE OR REPLACE FUNCTION wealthnova_referral_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."beneficiaryId", NEW."sourceUserId", NEW."investmentId", NEW."sourceLedgerId",
    NEW."sourceTransactionReference", NEW."rateVersionId", NEW."tier", NEW."rateBasisPoints", NEW."basisAmount", NEW."amount")
    IS DISTINCT FROM ROW(OLD."beneficiaryId", OLD."sourceUserId", OLD."investmentId", OLD."sourceLedgerId",
    OLD."sourceTransactionReference", OLD."rateVersionId", OLD."tier", OLD."rateBasisPoints", OLD."basisAmount", OLD."amount") THEN
    RAISE EXCEPTION 'Historical commission snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('PAID', 'REJECTED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'Final commission decisions cannot be reopened' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'PAID' AND OLD."status" <> 'PAID' THEN
    IF OLD."status" <> 'APPROVED'
      OR NOT EXISTS (SELECT 1 FROM "LedgerEntry" WHERE "referralCommissionId" = NEW."id"
        AND "userId" = NEW."beneficiaryId" AND "type" = 'REFERRAL_COMMISSION_CREDIT' AND "amount" = NEW."amount")
      OR NOT EXISTS (SELECT 1 FROM "CompanyFundEntry" WHERE "commissionId" = NEW."id"
        AND "type" = 'COMMISSION_TRANSFER' AND "amount" = -NEW."amount") THEN
      RAISE EXCEPTION 'Paid requires a completed funded wallet credit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- statement
DROP TRIGGER IF EXISTS wealthnova_referral_snapshot_guard ON "ReferralCommission";
-- statement
CREATE TRIGGER wealthnova_referral_snapshot_guard BEFORE UPDATE ON "ReferralCommission"
FOR EACH ROW EXECUTE FUNCTION wealthnova_referral_snapshot_guard();
-- statement
CREATE OR REPLACE FUNCTION wealthnova_rate_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rate history is append-only' USING ERRCODE = '23514';
END;
$$;
-- statement
DROP TRIGGER IF EXISTS wealthnova_rate_history_guard ON "ReferralRateVersion";
-- statement
CREATE TRIGGER wealthnova_rate_history_guard BEFORE UPDATE OR DELETE ON "ReferralRateVersion"
FOR EACH ROW EXECUTE FUNCTION wealthnova_rate_history_guard();
-- statement
SELECT wealthnova_generate_referral_commissions("id") FROM "Investment"
WHERE "status" IN ('ACTIVE', 'COMPLETED');
