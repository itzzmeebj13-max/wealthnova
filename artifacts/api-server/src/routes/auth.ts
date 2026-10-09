import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  GetCurrentUserResponse,
  LoginBody,
  LoginResponse,
  LogoutResponse,
  getPhilippineMobileNumberCandidates,
  normalizePhilippineMobileNumber,
  PHILIPPINE_MOBILE_VALIDATION_MESSAGE,
  RegisterBody,
  RegisterResponse,
  ValidateReferralCodeBody,
  ValidateReferralCodeResponse,
} from "@workspace/api-zod";
import { prisma } from "@workspace/db";
import { requireAuth, publicUserSelect, type PublicUser } from "../middlewares/auth";
import {
  clearSessionCookie,
  hashSessionToken,
  SESSION_COOKIE,
  startSession,
} from "../lib/auth-session";

const router: IRouter = Router();
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_PASSWORD_HASH =
  `scrypt$${"00".repeat(16)}$${"00".repeat(PASSWORD_KEY_LENGTH)}`;

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      PASSWORD_SCRYPT_OPTIONS,
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

class RegistrationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePasswordKey(password, salt);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, saltHex, expectedHex] = encoded.split("$");
  if (
    !saltHex ||
    !expectedHex ||
    !/^[0-9a-f]{32}$/i.test(saltHex) ||
    !/^[0-9a-f]{128}$/i.test(expectedHex)
  ) {
    return false;
  }

  const expected = Buffer.from(expectedHex, "hex");
  const actual = await derivePasswordKey(password, Buffer.from(saltHex, "hex"));

  return timingSafeEqual(actual, expected);
}

function toSessionUser(user: PublicUser) {
  return {
    ...user,
    createdAt: user.createdAt.toISOString(),
  };
}

async function createReferralCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `WN-${randomBytes(8).toString("hex").toUpperCase()}`;
    const alreadyUsed = await prisma.user.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!alreadyUsed) return code;
  }
  throw new Error("Could not allocate a referral code.");
}

router.post("/auth/register", async (request, response) => {
  const requestBody =
    request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body
      : {};
  const mobileNumber = normalizePhilippineMobileNumber(requestBody.mobileNumber);
  if (!mobileNumber) {
    response.status(400).json({ error: PHILIPPINE_MOBILE_VALIDATION_MESSAGE });
    return;
  }

  const parsed = RegisterBody.safeParse({ ...requestBody, mobileNumber });
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a valid password and referral code." });
    return;
  }

  const input = parsed.data;
  const referralCode = input.referralCode.trim().toUpperCase();
  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.$transaction(async (transaction) => {
      const existingUser = await transaction.user.findFirst({
        where: { mobileNumber: { in: getPhilippineMobileNumberCandidates(mobileNumber) } },
        select: { id: true },
      });
      if (existingUser) {
        throw new RegistrationError("An account already exists for this mobile number.", 409);
      }

      const referrer = await transaction.user.findUnique({
        where: { referralCode },
        select: { id: true, mobileNumber: true, status: true },
      });
      if (!referrer || referrer.status === "SUSPENDED") {
        throw new RegistrationError("That referral code is invalid or unavailable.", 400);
      }
      if (getPhilippineMobileNumberCandidates(referrer.mobileNumber).includes(mobileNumber)) {
        throw new RegistrationError("You cannot use your own referral code.", 400);
      }

      const newReferralCode = await createReferralCode();
      return transaction.user.create({
        data: {
          mobileNumber,
          passwordHash,
          referralCode: newReferralCode,
          referredBy: referrer.id,
        },
        select: publicUserSelect,
      });
    });

    await startSession(user.id, response);
    response.status(201).json(RegisterResponse.parse(toSessionUser(user)));
  } catch (error) {
    if (error instanceof RegistrationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      response.status(409).json({ error: "That mobile number or referral code is already in use." });
      return;
    }
    throw error;
  }
});

router.post("/auth/login", async (request, response) => {
  const requestBody =
    request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body
      : {};
  const mobileNumber = normalizePhilippineMobileNumber(requestBody.mobileNumber);
  if (!mobileNumber) {
    response.status(400).json({ error: PHILIPPINE_MOBILE_VALIDATION_MESSAGE });
    return;
  }

  const parsed = LoginBody.safeParse({ ...requestBody, mobileNumber });
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a valid password." });
    return;
  }

  const { password } = parsed.data;
  const user = await prisma.user.findFirst({
    where: { mobileNumber: { in: getPhilippineMobileNumberCandidates(mobileNumber) } },
    select: { ...publicUserSelect, passwordHash: true },
  });
  const validPassword = await verifyPassword(
    password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (!user || !validPassword || user.status !== "ACTIVE") {
    response.status(401).json({ error: "Mobile number or password is incorrect." });
    return;
  }

  await startSession(user.id, response);
  response.json(LoginResponse.parse(toSessionUser(user)));
});

router.get("/auth/me", requireAuth, (request, response) => {
  if (!request.user) {
    response.status(401).json({ error: "Sign in to continue." });
    return;
  }
  response.json(
    GetCurrentUserResponse.parse(toSessionUser(request.user)),
  );
});

router.post("/auth/logout", async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token.length >= 32 && token.length <= 128) {
    await prisma.session.deleteMany({
      where: { tokenHash: hashSessionToken(token) },
    });
  }
  clearSessionCookie(response);
  response.json(LogoutResponse.parse({ status: "ok" }));
});

router.post("/referrals/validate", async (request, response) => {
  const parsed = ValidateReferralCodeBody.safeParse(request.body);
  if (!parsed.success) {
    response.status(200).json(
      ValidateReferralCodeResponse.parse({
        valid: false,
        message: "Enter a referral code.",
      }),
    );
    return;
  }

  const code = parsed.data.referralCode.trim().toUpperCase();
  const user = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { status: true },
  });
  const valid = Boolean(user && user.status !== "SUSPENDED");
  response.json(
    ValidateReferralCodeResponse.parse({
      valid,
      message: valid
        ? "Referral code verified."
        : "We couldn't find an active referral for that code.",
    }),
  );
});

export default router;
