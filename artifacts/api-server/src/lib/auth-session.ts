import { createHmac, randomBytes } from "node:crypto";
import type { Response } from "express";
import { prisma } from "@workspace/db";

export const SESSION_COOKIE = "wealthnova_session";
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const sessionSecret: string = (() => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be configured with at least 32 characters.");
  }
  return secret;
})();

export function hashSessionToken(token: string): string {
  return createHmac("sha256", sessionSecret).update(token).digest("hex");
}

export async function startSession(userId: string, response: Response) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

  await prisma.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt,
    },
  });

  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api",
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: Response) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api",
  });
}
