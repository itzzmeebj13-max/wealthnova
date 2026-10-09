import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const referralCode = (
  process.env.WEALTHNOVA_BOOTSTRAP_REFERRAL_CODE ?? "NOVA-START"
)
  .trim()
  .toUpperCase();
const plans = [
  ["plan-350", "Plan 1", "350.00", "75.00"],
  ["plan-500", "Plan 2", "500.00", "100.00"],
  ["plan-700", "Plan 3", "700.00", "150.00"],
  ["plan-1500", "Plan 4", "1500.00", "330.00"],
  ["plan-2500", "Plan 5", "2500.00", "425.00"],
  ["plan-6500", "Plan 6", "6500.00", "1300.00"],
  ["plan-10500", "Plan 7", "10500.00", "2205.00"],
];

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

  for (const [id, name, principalAmount, dailyAmount] of plans) {
    await prisma.investmentPlan.upsert({
      where: { id },
      update: {
        name,
        principalAmount,
        dailyAmount,
        duration: 25,
        isActive: true,
      },
      create: {
        id,
        name,
        principalAmount,
        dailyAmount,
        duration: 25,
        isActive: true,
      },
    });
  }
  process.stdout.write("WealthNova bootstrap referral and investment plans are ready.\n");
} finally {
  await prisma.$disconnect();
}
