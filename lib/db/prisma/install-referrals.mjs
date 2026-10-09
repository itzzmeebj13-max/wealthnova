import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
try {
const sql = (await Promise.all(["referral-events.sql", "referral-deposits.sql"].map(name =>
  readFile(new URL(`./${name}`, import.meta.url), "utf8")))).join("\n-- statement\n");
  await db.$transaction(async tx => {
    for (const statement of sql.split(/^-- statement\s*$/m).map(s => s.trim()).filter(Boolean)) {
      await tx.$executeRawUnsafe(statement);
    }
  }, { timeout: 60000 });
  console.log("Referral event handlers and zero-balance operating reserve installed. Existing balances and rate snapshots were preserved.");
} finally { await db.$disconnect(); }
