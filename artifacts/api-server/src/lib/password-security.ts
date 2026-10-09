import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const LEGACY = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const CURRENT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const DUMMY_PASSWORD_HASH = `scrypt-v2$${"00".repeat(16)}$${"00".repeat(64)}`;

function derive(password: string, salt: Buffer, options: typeof CURRENT): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, options,
    (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, CURRENT);
  return `scrypt-v2$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [scheme, salt, expected, extra] = encoded.split("$");
  if (extra !== undefined || !["scrypt", "scrypt-v2"].includes(scheme ?? "") ||
    !/^[a-f0-9]{32}$/i.test(salt ?? "") || !/^[a-f0-9]{128}$/i.test(expected ?? "")) return false;
  const key = await derive(password, Buffer.from(salt, "hex"), scheme === "scrypt" ? LEGACY : CURRENT);
  return timingSafeEqual(key, Buffer.from(expected, "hex"));
}
