import { Router, type IRouter } from "express";
import {
  GetDashboardSummaryResponse,
  GetDepositStatusResponse,
  GetMyReferralsResponse,
  GetPlansResponse,
} from "@workspace/api-zod";
import { prisma } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { mapInvestment, moneyString } from "../lib/investments";
import { getPaymentSettings, mapPaymentSettings } from "../lib/deposits";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (request, response) => {
  const user = request.user;
  if (!user) {
    response.status(401).json({ error: "Sign in to continue." });
    return;
  }

  const now = new Date();
  await prisma.investment.updateMany({
    where: {
      userId: user.id,
      status: "ACTIVE",
      endDate: { lte: now },
    },
    data: { status: "COMPLETED" },
  });
  const [referralCount, wallet, invested, earnings, activeInvestments] =
    await Promise.all([
      prisma.user.count({ where: { referredBy: user.id } }),
      prisma.wallet.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      }),
      prisma.investment.aggregate({
        where: { userId: user.id, status: { not: "CANCELLED" } },
        _sum: { principalAmount: true },
      }),
      prisma.ledgerEntry.aggregate({
        where: { userId: user.id, type: "VERIFIED_EARNING_CREDIT" },
        _sum: { amount: true },
      }),
      prisma.investment.findMany({
        where: { userId: user.id, status: "ACTIVE" },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
  response.json(
    GetDashboardSummaryResponse.parse({
      referralCount,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      availableBalance: moneyString(wallet.availableBalance),
      totalInvested: moneyString(invested._sum.principalAmount ?? 0),
      totalEarnings: moneyString(earnings._sum.amount ?? 0),
      activeInvestments: activeInvestments.map((investment) =>
        mapInvestment(investment, now),
      ),
    }),
  );
});

router.get("/referrals/me", requireAuth, async (request, response) => {
  const user = request.user;
  if (!user) {
    response.status(401).json({ error: "Sign in to continue." });
    return;
  }

  const referralCount = await prisma.user.count({
    where: { referredBy: user.id },
  });
  response.json(
    GetMyReferralsResponse.parse({
      referralCode: user.referralCode,
      referralLink: `/register?referralCode=${encodeURIComponent(user.referralCode)}`,
      referralCount,
    }),
  );
});

router.get("/plans", async (_request, response) => {
  const plans = await prisma.investmentPlan.findMany({
    where: { isActive: true },
    orderBy: { principalAmount: "asc" },
  });
  response.json(
    GetPlansResponse.parse(
      plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        currency: "PHP",
        principalAmount: moneyString(plan.principalAmount),
        dailyAmount: moneyString(plan.dailyAmount),
        duration: plan.duration,
        status: "AVAILABLE",
      })),
    ),
  );
});

router.get("/deposits/status", async (_request, response) => {
  const settings = mapPaymentSettings(await getPaymentSettings());
  response.json(
    GetDepositStatusResponse.parse({
      enabled: settings.enabled,
      message: settings.enabled
        ? "Manual GCash deposit requests are available. Every request requires verification; submitting does not credit your wallet."
        : "Deposit submissions are disabled. Please do not send money.",
    }),
  );
});

export default router;
