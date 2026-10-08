import { Router, type IRouter } from "express";
import {
  GetDashboardSummaryResponse,
  GetDepositStatusResponse,
  GetMyReferralsResponse,
  GetPlansResponse,
} from "@workspace/api-zod";
import { prisma } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (request, response) => {
  const user = request.user;
  if (!user) {
    response.status(401).json({ error: "Sign in to continue." });
    return;
  }

  const referralCount = await prisma.user.count({
    where: { referredBy: user.id },
  });
  response.json(
    GetDashboardSummaryResponse.parse({
      referralCount,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
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

router.get("/plans", (_request, response) => {
  response.json(GetPlansResponse.parse([]));
});

router.get("/deposits/status", (_request, response) => {
  response.json(
    GetDepositStatusResponse.parse({
      enabled: false,
      message: "Deposits are unavailable until a real payment provider is configured.",
    }),
  );
});

export default router;
