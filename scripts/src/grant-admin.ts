import { prisma } from "@workspace/db";
import { getPhilippineMobileNumberCandidates } from "@workspace/api-zod";

// Operator-only bootstrap, never exposed as a web endpoint. No default/admin
// passwords or new accounts are created.
async function main() {
  const mobile = process.argv[2];
  if (!mobile || process.argv[3] !== "--confirm-admin-access") {
    throw new Error("Usage: pnpm --filter @workspace/scripts grant-admin <existing-mobile-number> --confirm-admin-access");
  }
  const candidates = getPhilippineMobileNumberCandidates(mobile);
  if (!candidates.length) throw new Error("Enter a valid existing Philippine mobile number.");
  const matches = await prisma.user.findMany({ where: { mobileNumber: { in: candidates } } });
  if (matches.length > 1) throw new Error("Multiple account formats matched. Resolve the account ambiguity before granting Admin access.");
  const user = matches[0];
  if (!user || user.status !== "ACTIVE") {
    throw new Error("An existing, active member account is required. No account was changed.");
  }
  await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
  process.stdout.write("Admin access granted to the selected existing active account. Sign in again to see admin pages.\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Admin setup failed."}\n`);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
