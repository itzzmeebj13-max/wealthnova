import { Prisma, type Investment, type InvestmentPlan } from "@prisma/client";
import { prisma } from "@workspace/db";

export class InvestmentOperationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function moneyString(value: Prisma.Decimal | string | number): string {
  return new Prisma.Decimal(value).toFixed(2);
}

export function completedDays(
  startDate: Date,
  duration: number,
  now: Date = new Date(),
): number {
  const elapsed = Math.floor((now.getTime() - startDate.getTime()) / 86_400_000);
  return Math.min(duration, Math.max(0, elapsed));
}

export function mapInvestment(
  investment: Investment & { plan: InvestmentPlan },
  now: Date = new Date(),
) {
  const daysCompleted = completedDays(investment.startDate, investment.duration, now);
  return {
    id: investment.id,
    planId: investment.planId,
    planName: investment.plan.name,
    principalAmount: moneyString(investment.principalAmount),
    dailyAmount: moneyString(investment.dailyAmount),
    duration: investment.duration,
    startDate: investment.startDate.toISOString(),
    endDate: investment.endDate.toISOString(),
    daysCompleted,
    daysRemaining: Math.max(0, investment.duration - daysCompleted),
    accumulatedAmount: moneyString(investment.accumulatedAmount),
    status: investment.status,
  };
}

type StartResult = {
  investment: Investment & { plan: InvestmentPlan };
  availableBalance: Prisma.Decimal;
  replayed: boolean;
};

async function findReplay(
  userId: string,
  planId: string,
  idempotencyKey: string,
): Promise<StartResult | null> {
  const existing = await prisma.investment.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    include: { plan: true },
  });
  if (!existing) return null;
  if (existing.planId !== planId) {
    throw new InvestmentOperationError(
      "This request key was already used for a different plan.",
      409,
    );
  }
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  return {
    investment: existing,
    availableBalance: wallet?.availableBalance ?? new Prisma.Decimal(0),
    replayed: true,
  };
}

export async function startInvestment(input: {
  userId: string;
  planId: string;
  idempotencyKey: string;
}): Promise<StartResult> {
  const replay = await findReplay(input.userId, input.planId, input.idempotencyKey);
  if (replay) return replay;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const existing = await transaction.investment.findUnique({
            where: {
              userId_idempotencyKey: {
                userId: input.userId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            include: { plan: true },
          });
          if (existing) {
            if (existing.planId !== input.planId) {
              throw new InvestmentOperationError(
                "This request key was already used for a different plan.",
                409,
              );
            }
            const wallet = await transaction.wallet.findUnique({
              where: { userId: input.userId },
            });
            return {
              investment: existing,
              availableBalance: wallet?.availableBalance ?? new Prisma.Decimal(0),
              replayed: true,
            };
          }

          const plan = await transaction.investmentPlan.findUnique({
            where: { id: input.planId },
          });
          if (!plan || !plan.isActive) {
            throw new InvestmentOperationError("This plan is not available.", 404);
          }

          await transaction.wallet.upsert({
            where: { userId: input.userId },
            update: {},
            create: { userId: input.userId },
          });
          const debit = await transaction.wallet.updateMany({
            where: {
              userId: input.userId,
              availableBalance: { gte: plan.principalAmount },
            },
            data: {
              availableBalance: { decrement: plan.principalAmount },
            },
          });
          if (debit.count !== 1) {
            throw new InvestmentOperationError(
              "Your verified available balance is not enough for this plan.",
              409,
            );
          }

          const startDate = new Date();
          const endDate = new Date(
            startDate.getTime() + plan.duration * 86_400_000,
          );
          const investment = await transaction.investment.create({
            data: {
              userId: input.userId,
              planId: plan.id,
              principalAmount: plan.principalAmount,
              dailyAmount: plan.dailyAmount,
              duration: plan.duration,
              startDate,
              endDate,
              accumulatedAmount: new Prisma.Decimal(0),
              idempotencyKey: input.idempotencyKey,
              status: "ACTIVE",
            },
            include: { plan: true },
          });
          const wallet = await transaction.wallet.findUniqueOrThrow({
            where: { userId: input.userId },
          });
          await transaction.ledgerEntry.create({
            data: {
              userId: input.userId,
              investmentId: investment.id,
              reference: `investment:${input.userId}:${input.idempotencyKey}`,
              type: "INVESTMENT_DEBIT",
              amount: plan.principalAmount,
              balanceAfter: wallet.availableBalance,
            },
          });

          return {
            investment,
            availableBalance: wallet.availableBalance,
            replayed: false,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 2
      ) {
        continue;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const concurrentReplay = await findReplay(
          input.userId,
          input.planId,
          input.idempotencyKey,
        );
        if (concurrentReplay) return concurrentReplay;
      }
      throw error;
    }
  }

  throw new InvestmentOperationError(
    "The investment could not be processed. Please retry.",
    409,
  );
}
