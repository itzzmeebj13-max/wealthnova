-- Policy activation is append-only and idempotent. Never backfill pre-cutover deposits.
INSERT INTO "ReferralRateVersion" ("id","version","tier1BasisPoints","tier2BasisPoints","tier3BasisPoints",
  "sourceType","effectiveFrom","changeReason","createdAt")
SELECT 'referral-deposit-policy', COALESCE(MAX("version"),0)+1,2500,300,100,
  'DEPOSIT',CURRENT_TIMESTAMP,'Owner-requested policy: future verified deposits only, 25% / 3% / 1%; historical investment commissions preserved.',CURRENT_TIMESTAMP
FROM "ReferralRateVersion"
HAVING NOT EXISTS (SELECT 1 FROM "ReferralRateVersion" WHERE "id"='referral-deposit-policy');
-- statement
CREATE OR REPLACE FUNCTION wealthnova_referral_relationship_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id text; visited text[];
BEGIN
  IF TG_OP='UPDATE' AND NEW."referredBy" IS DISTINCT FROM OLD."referredBy" THEN
    RAISE EXCEPTION 'Original referrer cannot be changed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    parent_id:=NEW."referredBy"; visited:=ARRAY[NEW."id"];
    WHILE parent_id IS NOT NULL LOOP
      IF parent_id=ANY(visited) THEN RAISE EXCEPTION 'Self or circular referral is forbidden' USING ERRCODE='23514'; END IF;
      visited:=array_append(visited,parent_id);
      SELECT "referredBy" INTO parent_id FROM "User" WHERE "id"=parent_id;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
-- statement
CREATE OR REPLACE FUNCTION wealthnova_generate_deposit_commissions(source_deposit text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source_record record; source_entry record; rate_record record; parent_record record;
  parent_id text; visited text[]; tier_number integer; points integer; reward numeric(16,2); commission_id text;
BEGIN
  SELECT d.*,u."referredBy" INTO source_record FROM "DepositRequest" d
    JOIN "User" u ON u."id"=d."userId" WHERE d."id"=source_deposit;
  IF NOT FOUND OR source_record."status"<>'APPROVED' OR source_record."approvedAt" IS NULL
    OR source_record."verifiedAmount" IS NULL OR source_record."verifiedAmount"<=0 THEN RETURN; END IF;
  SELECT * INTO rate_record FROM "ReferralRateVersion"
    WHERE "sourceType"='DEPOSIT' AND "effectiveFrom"<=source_record."approvedAt"
    ORDER BY "effectiveFrom" DESC,"version" DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM "DepositDecisionAudit" a WHERE a."depositId"=source_deposit
    AND a."decision"='APPROVED' AND a."adminId"=source_record."reviewedById"
    AND a."verifiedAmount"=source_record."verifiedAmount" AND length(trim(a."verificationNote"))>=10) THEN RETURN; END IF;
  SELECT * INTO source_entry FROM "LedgerEntry" WHERE "depositRequestId"=source_deposit AND "type"='DEPOSIT_CREDIT'
    AND "userId"=source_record."userId" AND "amount"=source_record."verifiedAmount";
  IF NOT FOUND THEN RETURN; END IF;
  parent_id:=source_record."referredBy"; visited:=ARRAY[source_record."userId"];
  FOR tier_number IN 1..3 LOOP
    EXIT WHEN parent_id IS NULL;
    IF parent_id=ANY(visited) THEN RAISE EXCEPTION 'Referral cycle detected' USING ERRCODE='23514'; END IF;
    visited:=array_append(visited,parent_id);
    SELECT * INTO parent_record FROM "User" WHERE "id"=parent_id;
    EXIT WHEN NOT FOUND;
    points:=CASE tier_number WHEN 1 THEN rate_record."tier1BasisPoints" WHEN 2 THEN rate_record."tier2BasisPoints" ELSE rate_record."tier3BasisPoints" END;
    reward:=round(source_record."verifiedAmount"*points/10000,2);
    IF parent_record."status"='ACTIVE' AND points>0 AND reward>0 THEN
      commission_id:='rdep_'||md5(source_deposit||':'||tier_number::text);
      INSERT INTO "ReferralCommission" ("id","beneficiaryId","sourceUserId","depositId","sourceLedgerId",
        "sourceTransactionReference","rateVersionId","tier","rateBasisPoints","basisAmount","amount","status","createdAt","updatedAt")
      VALUES (commission_id,parent_id,source_record."userId",source_deposit,source_entry."id",
        source_record."transactionReference",rate_record."id",tier_number,points,source_record."verifiedAmount",reward,'PENDING',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT DO NOTHING;
      INSERT INTO "ReferralNotification" ("id","userId","eventKey","type","message","commissionId","createdAt")
      VALUES ('nverify_'||md5(source_deposit||parent_id),parent_id,'verified-deposit:'||source_deposit||':'||parent_id,
        'VERIFIED_TRANSACTION','A referred member’s deposit was independently verified. Commission records are not spendable wallet funds.',commission_id,CURRENT_TIMESTAMP)
      ON CONFLICT DO NOTHING;
      INSERT INTO "ReferralNotification" ("id","userId","eventKey","type","message","commissionId","createdAt")
      VALUES ('nrecord_'||md5(commission_id),parent_id,'commission:'||commission_id,'COMMISSION_RECORDED',
        'A deposit referral commission was recorded as Pending. Payment requires verified company funding and Admin authorization.',commission_id,CURRENT_TIMESTAMP)
      ON CONFLICT DO NOTHING;
    END IF;
    parent_id:=parent_record."referredBy";
  END LOOP;
END $$;
-- statement
CREATE OR REPLACE FUNCTION wealthnova_referral_deposit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='LedgerEntry' THEN
    PERFORM wealthnova_generate_deposit_commissions(NEW."depositRequestId");
  ELSE PERFORM wealthnova_generate_deposit_commissions(NEW."depositId");
  END IF;
  RETURN NEW;
END $$;
-- statement
DROP TRIGGER IF EXISTS wealthnova_referral_verified_deposit_ledger ON "LedgerEntry";
-- statement
CREATE TRIGGER wealthnova_referral_verified_deposit_ledger AFTER INSERT ON "LedgerEntry"
FOR EACH ROW WHEN (NEW."type"='DEPOSIT_CREDIT') EXECUTE FUNCTION wealthnova_referral_deposit_event();
-- statement
DROP TRIGGER IF EXISTS wealthnova_referral_verified_deposit_audit ON "DepositDecisionAudit";
-- statement
CREATE TRIGGER wealthnova_referral_verified_deposit_audit AFTER INSERT ON "DepositDecisionAudit"
FOR EACH ROW WHEN (NEW."decision"='APPROVED') EXECUTE FUNCTION wealthnova_referral_deposit_event();
-- statement
-- Recover only verifications after the recorded cutover; never backfill old deposits.
SELECT wealthnova_generate_deposit_commissions(d."id") FROM "DepositRequest" d
WHERE d."status"='APPROVED' AND d."approvedAt">=(SELECT MIN("effectiveFrom") FROM "ReferralRateVersion" WHERE "sourceType"='DEPOSIT');
