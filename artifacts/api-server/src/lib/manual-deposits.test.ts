import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

// Exercise the single merged deposit implementation in a disposable schema.
// This never enables shared settings or changes an existing member's funds.
const schema = `manual_deposit_test_${randomUUID().replaceAll("-", "")}`;
const root = new PrismaClient();
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("schema", schema);
const testDatabaseUrl = url.toString();
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });
let checks = 0;
function check(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected);
  checks++;
}

try {
  await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const migrated = spawnSync("pnpm", [
    "--filter", "@workspace/db", "exec", "prisma", "migrate", "deploy",
    "--schema", "prisma/schema.prisma",
  ], {
    cwd: path.resolve(process.cwd(), "../.."),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    encoding: "utf8",
  });
  if (migrated.status !== 0) {
    throw new Error(`Isolated migrations failed: ${migrated.stderr || migrated.stdout}`);
  }
  (globalThis as unknown as { prisma: PrismaClient }).prisma = db;
  await db.user.create({
    data: {
      mobileNumber: "WEALTHNOVA-ROOT", referralCode: "NOVA-START",
      passwordHash: "disabled-test-only", status: "INVITE_ONLY",
    },
  });
  // Existing permission, upload, submission, settings, review and audit tests.
  // Their temporary uploads/accounts are cleaned up by their own finally block.
  await import("./deposits.test");

  const { decideDeposit } = await import("./deposit-decisions");
  const admin = await db.user.create({
    data: { mobileNumber: randomUUID(), referralCode: randomUUID(), passwordHash: "disabled-test-only", role: "ADMIN" },
  });
  const member = await db.user.create({
    data: {
      mobileNumber: randomUUID(), referralCode: randomUUID(),
      passwordHash: "disabled-test-only", wallet: { create: {} },
    },
  });
  async function pending(amount: string) {
    const image = await db.depositImage.create({
      data: {
        userId: member.id, purpose: "RECEIPT", contentType: "image/png",
        size: 100, objectPath: `isolated-not-stored/${randomUUID()}`, digest: randomUUID(),
      },
    });
    return db.depositRequest.create({
      data: {
        userId: member.id, amount, transactionReference: randomUUID(),
        receiptImageId: image.id, receiptDigest: image.digest,
        idempotencyKey: randomUUID(), settingsVersion: 0,
        accountName: "ISOLATED TEST ONLY", accountNumber: "09990000001",
      },
    });
  }
  const approval = {
    type: "APPROVE" as const,
    data: {
      verifiedAmount: "90.10", confirmedPaymentReceived: true,
      confirmedAmountDifference: true,
      verificationNote: "Synthetic bookkeeping test in a disposable database only.",
    },
  };
  const deposit = await pending("100.10");
  await db.$executeRawUnsafe(`CREATE FUNCTION "${schema}".fail_test_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated forced ledger failure'; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER forced_ledger_failure BEFORE INSERT ON "${schema}"."LedgerEntry" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_test_credit()`);
  await assert.rejects(() => decideDeposit(admin.id, deposit.id, approval, db));
  checks++;
  check((await db.depositRequest.findUniqueOrThrow({ where: { id: deposit.id } })).status, "PENDING_VERIFICATION");
  check((await db.wallet.findUniqueOrThrow({ where: { userId: member.id } })).availableBalance.toFixed(2), "0.00");
  check(await db.ledgerEntry.count(), 0);
  check(await db.depositDecisionAudit.count(), 0);
  await db.$executeRawUnsafe(`DROP TRIGGER forced_ledger_failure ON "${schema}"."LedgerEntry"`);
  const results = await Promise.all([
    decideDeposit(admin.id, deposit.id, approval, db),
    decideDeposit(admin.id, deposit.id, approval, db),
  ]);
  check(results.filter(result => !result.alreadyProcessed).length, 1);
  check(await db.ledgerEntry.count(), 1);
  check(await db.depositDecisionAudit.count(), 1);
  check((await db.wallet.findUniqueOrThrow({ where: { userId: member.id } })).availableBalance.toFixed(2), "90.10");
  const reviewed = await db.depositRequest.findUniqueOrThrow({ where: { id: deposit.id } });
  check(reviewed.reviewedById, admin.id);
  check(Boolean(reviewed.reviewedAt), true);
  check(reviewed.verifiedAmount?.toFixed(2), "90.10");
  const replay = await decideDeposit(admin.id, deposit.id, approval, db);
  check(replay.alreadyProcessed, true);
  check(await db.ledgerEntry.count(), 1);

  const rejected = await pending("10.00");
  const rejection = { type: "REJECT" as const, data: { reason: "Synthetic test: no actual payment received." } };
  await decideDeposit(admin.id, rejected.id, rejection, db);
  const rejectedReplay = await decideDeposit(admin.id, rejected.id, rejection, db);
  check(rejectedReplay.alreadyProcessed, true);
  check((await db.wallet.findUniqueOrThrow({ where: { userId: member.id } })).availableBalance.toFixed(2), "90.10");
  check(await db.ledgerEntry.count(), 1);
  await assert.rejects(() => decideDeposit(admin.id, rejected.id, approval, db));
  checks++;
  const small = await Promise.all([pending("0.10"), pending("0.20")]);
  await Promise.all(small.map((request, index) => decideDeposit(admin.id, request.id, {
    ...approval, data: { ...approval.data, verifiedAmount: index === 0 ? "0.10" : "0.20" },
  }, db)));
  check((await db.wallet.findUniqueOrThrow({ where: { userId: member.id } })).availableBalance.toFixed(2), "90.40");
  check(await db.ledgerEntry.count(), 3);
  console.log(`Merged deposit suite and ${checks} additional isolated rollback/concurrency/replay/decimal checks passed. Existing records were not changed.`);
} finally {
  await db.$disconnect();
  await root.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await root.$disconnect();
}
