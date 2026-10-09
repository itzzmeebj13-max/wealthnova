import { randomUUID, createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import { prisma } from "@workspace/db";
import type { DepositImagePurpose } from "@prisma/client";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: "http://127.0.0.1:1106/token",
    type: "external_account",
    credential_source: {
      url: "http://127.0.0.1:1106/credential",
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class DepositError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function privateFile(path: string) {
  // Paths are server-generated, never accepted from the browser.
  const match = path.match(/^\/?([^/]+)\/(.+)$/);
  if (!match) throw new Error("Private storage is not configured.");
  return storage.bucket(match[1]!).file(match[2]!);
}

export async function sanitizeImage(bytes: Buffer, declaredType: string) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new DepositError("Please upload an image no larger than 5 MB.", 413);
  }
  if (!IMAGE_TYPES.includes(declaredType)) {
    throw new DepositError("Please upload a JPEG, PNG, or WebP image.");
  }
  try {
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    const formats = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    if (!(metadata.format && metadata.format in formats) ||
        formats[metadata.format as keyof typeof formats] !== declaredType ||
        (metadata.pages ?? 1) !== 1) {
      throw new Error("Invalid image format");
    }
    // Fully decode and re-encode, removing metadata and appended payloads.
    const sanitized = await image.rotate().resize({
      width: 2048, height: 2048, fit: "inside", withoutEnlargement: true,
    }).png().toBuffer();
    if (sanitized.length > MAX_IMAGE_BYTES) {
      throw new DepositError("The image is too large. Please use a smaller image.", 413);
    }
    return sanitized;
  } catch (error) {
    if (error instanceof DepositError) throw error;
    throw new DepositError("Please upload a valid, non-animated JPEG, PNG, or WebP image.");
  }
}

export async function storePrivateImage(userId: string, purpose: DepositImagePurpose, bytes: Buffer, declaredType: string) {
  const sanitized = await sanitizeImage(bytes, declaredType);
  const directory = process.env.PRIVATE_OBJECT_DIR?.replace(/\/$/, "");
  if (!directory) throw new Error("Private storage is not configured.");
  const objectPath = `${directory}/deposit-images/${randomUUID()}.png`;
  const file = privateFile(objectPath);
  await file.save(sanitized, {
    resumable: false,
    contentType: "image/png",
    metadata: { cacheControl: "private, no-store" },
  });
  try {
    return await prisma.depositImage.create({
      data: {
        userId, purpose, objectPath, contentType: "image/png", size: sanitized.length,
        digest: createHash("sha256").update(sanitized).digest("hex"),
      },
    });
  } catch (error) {
    await file.delete().catch(() => undefined);
    throw error;
  }
}

export async function readPrivateImage(path: string) {
  const [bytes] = await privateFile(path).download();
  return bytes;
}

export async function deletePrivateImage(path: string) {
  await privateFile(path).delete({ ignoreNotFound: true });
}
