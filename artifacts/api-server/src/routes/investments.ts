import { Router, type IRouter } from "express";
import { StartInvestmentBody, StartInvestmentResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import {
  InvestmentOperationError,
  mapInvestment,
  moneyString,
  startInvestment,
} from "../lib/investments";

const router: IRouter = Router();

router.post("/investments", requireAuth, async (request, response): Promise<void> => {
  if (!request.user) {
    response.status(401).json({ error: "Sign in to continue." });
    return;
  }
  const parsed = StartInvestmentBody.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Select a valid plan and provide a request key." });
    return;
  }
  try {
    const result = await startInvestment({
      userId: request.user.id,
      planId: parsed.data.planId,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    response.status(result.replayed ? 200 : 201).json(
      StartInvestmentResponse.parse({
        investment: mapInvestment(result.investment),
        availableBalance: moneyString(result.availableBalance),
        replayed: result.replayed,
      }),
    );
  } catch (error) {
    if (error instanceof InvestmentOperationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

export default router;
