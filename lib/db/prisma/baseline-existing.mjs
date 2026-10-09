// Trusted development-workspace setup, not application startup/deployment DDL.
// A newer branch used db:push before migrations existed. Record that baseline
// only after checking the exact prior branch schema, without running old CREATEs.
import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";

const db = new PrismaClient();
try {
  const columns = await db.$queryRaw`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
  `;
  const has = (table, column) => columns.some(row => row.table_name === table && row.column_name === column);
  const incoming = has("DepositRequest", "receiptImageId") && !has("DepositRequest", "receiptFileId");
  const original = has("User", "mobileNumber") && !has("DepositRequest", "id");
  if (!incoming && !original) process.exitCode = 0;
  else {
    if (incoming) {
      const required = [
        ["User", "passwordHash"], ["User", "role"], ["Session", "tokenHash"],
        ["Wallet", "availableBalance"], ["Wallet", "reservedBalance"],
        ["Wallet", "activeWithdrawalId"], ["InvestmentPlan", "principalAmount"],
        ["Investment", "idempotencyKey"], ["LedgerEntry", "depositRequestId"],
        ["LedgerEntry", "withdrawalId"], ["LedgerEntry", "balanceBucket"],
        ["DepositRequest", "verifiedAmount"], ["DepositRequest", "settingsVersion"],
        ["DepositImage", "digest"], ["DepositPaymentSettings", "submissionsEnabled"],
        ["DepositPaymentSettings", "version"], ["DepositDecisionAudit", "adminId"],
        ["WithdrawalRequest", "processingById"], ["WithdrawalAudit", "decision"],
        ["WithdrawalNotification", "status"],
      ];
      if (required.some(([table, column]) => !has(table, column))) {
        throw new Error("Existing schema is not the expected manual-deposit/withdrawal baseline. Inspect it before applying migrations; no baseline was recorded.");
      }
    }
    const names = incoming
      ? ["202610090001_baseline", "202610090002_manual_gcash", "202610090003_deposit_constraints"]
      : ["202610090001_baseline"];
    const rows = has("_prisma_migrations", "migration_name")
      ? await db.$queryRaw`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`
      : [];
    for (const name of names) {
      const applied = rows.find(row => row.migration_name === name && row.finished_at && !row.rolled_back_at);
      if (applied) continue;
      if (rows.some(row => row.migration_name === name && !row.rolled_back_at)) {
        throw new Error(`Migration ${name} needs explicit inspection before baseline adoption.`);
      }
      const result = spawnSync("pnpm", ["exec", "prisma", "migrate", "resolve", "--applied", name, "--schema", "prisma/schema.prisma"], {
        stdio: "inherit",
      });
      if (result.status !== 0) throw new Error(`Could not record existing baseline ${name}.`);
    }
  }
} finally {
  await db.$disconnect();
}
