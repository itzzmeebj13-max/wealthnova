import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@workspace/db";
import { completedDays, startInvestment, InvestmentOperationError } from "./investments";

// Isolated development fixture, removed in finally. No member funds or payment
// confirmations are created by this test.
const suffix = randomUUID();
let userId: string | undefined;
try {
  const root = await prisma.user.findUniqueOrThrow({ where: { referralCode: "NOVA-START" } });
  const user = await prisma.user.create({
    data: {
      mobileNumber: `TEST-INVESTMENT-${suffix}`,
      passwordHash: "disabled-test-fixture",
      referralCode: `TEST-${suffix}`,
      referredBy: root.id,
      wallet: { create: { availableBalance: "700.00" } },
    },
  });
  userId = user.id;
  const key = randomUUID();
  const first = await startInvestment({ userId, planId: "plan-350", idempotencyKey: key });
  assert.equal(first.investment.principalAmount.toFixed(2), "350.00");
  assert.equal(first.investment.dailyAmount.toFixed(2), "75.00");
  assert.equal(first.availableBalance.toFixed(2), "350.00");
  assert.equal(first.investment.accumulatedAmount.toFixed(2), "0.00");
  assert.equal(first.investment.endDate.getTime() - first.investment.startDate.getTime(), 25 * 86_400_000);
  const replay = await startInvestment({ userId, planId: "plan-350", idempotencyKey: key });
  assert.equal(replay.investment.id, first.investment.id);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    startInvestment({ userId, planId: "plan-500", idempotencyKey: key }),
    (error: unknown) => error instanceof InvestmentOperationError && error.status === 409,
  );
  const concurrent = await Promise.allSettled([
    startInvestment({ userId, planId: "plan-350", idempotencyKey: randomUUID() }),
    startInvestment({ userId, planId: "plan-350", idempotencyKey: randomUUID() }),
  ]);
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).availableBalance.toFixed(2), "0.00");
  await assert.rejects(
    startInvestment({ userId, planId: "plan-500", idempotencyKey: randomUUID() }),
    (error: unknown) => error instanceof InvestmentOperationError && error.status === 409,
  );
  assert.equal(await prisma.investment.count({ where: { userId } }), 2);
  assert.equal(await prisma.ledgerEntry.count({ where: { userId, type: "INVESTMENT_DEBIT" } }), 2);
  assert.equal(completedDays(new Date("2026-01-01T00:00:00Z"), 25, new Date("2026-01-03T12:00:00Z")), 2);
  assert.equal(completedDays(new Date("2026-01-01T00:00:00Z"), 25, new Date("2026-03-01T00:00:00Z")), 25);
  process.stdout.write("Investment checks passed: server plan values, debit/ledger, replay protection, concurrency, insufficient balance, and day counts.\n");
} finally {
  if (userId) {
    await prisma.ledgerEntry.deleteMany({ where: { userId } });
    await prisma.investment.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.$disconnect();
}
