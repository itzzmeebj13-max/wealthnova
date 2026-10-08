import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const referralCode = (
  process.env.WEALTHNOVA_BOOTSTRAP_REFERRAL_CODE ?? "NOVA-START"
)
  .trim()
  .toUpperCase();

if (!/^[A-Z0-9-]{3,32}$/.test(referralCode)) {
  throw new Error(
    "WEALTHNOVA_BOOTSTRAP_REFERRAL_CODE must be 3-32 letters, digits, or hyphens.",
  );
}

try {
  await prisma.user.upsert({
    where: { mobileNumber: "WEALTHNOVA-ROOT" },
    update: { referralCode },
    create: {
      mobileNumber: "WEALTHNOVA-ROOT",
      passwordHash: `disabled-${randomBytes(32).toString("hex")}`,
      referralCode,
      role: "ADMIN",
      status: "INVITE_ONLY",
    },
  });
  process.stdout.write("WealthNova bootstrap referral is ready.\n");
} finally {
  await prisma.$disconnect();
}
