import type { NextFunction, Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "@workspace/db";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { hashSessionToken, SESSION_COOKIE } from "../lib/auth-session";

export const publicUserSelect = {
  id: true,
  mobileNumber: true,
  referralCode: true,
  role: true,
  status: true,
  referredBy: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{
  select: typeof publicUserSelect;
}>;

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export async function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];

  if (typeof token !== "string" || token.length < 32 || token.length > 128) {
    response.status(401).json({ error: "Sign in to continue." });
    return;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: { select: publicUserSelect } },
  });

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    if (session) {
      await prisma.session.delete({ where: { id: session.id } });
    }
    response.status(401).json({ error: "Your session has expired. Sign in again." });
    return;
  }

  if (session.user.status !== "ACTIVE") {
    response.status(403).json({ error: "This account is not active." });
    return;
  }

  request.user = session.user;
  GetCurrentUserResponse.parse({
    ...session.user,
    createdAt: session.user.createdAt.toISOString(),
  });
  next();
}
