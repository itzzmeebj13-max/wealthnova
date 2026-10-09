import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
try {
  const sql = await readFile(new URL("./referral-events.sql", import.meta.url), "utf8");
  await db.$transaction(async tx => {
    for (const statement of sql.split(/^-- statement\s*$/m).map(s => s.trim()).filter(Boolean)) {
      await tx.$executeRawUnsafe(statement);
    }
  }, { timeout: 60000 });
  console.log("Referral event handlers and zero-balance operating reserve installed. Existing balances and rate snapshots were preserved.");
} finally { await db.$disconnect(); }
