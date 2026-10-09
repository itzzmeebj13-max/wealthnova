import { createHash } from "node:crypto";
import type { RequestHandler, ErrorRequestHandler } from "express";
import { normalizePhilippineMobileNumber } from "@workspace/api-zod";

type Bucket = { count: number; until: number };
// Bounded, expiring per-instance limits. Shared-store limits are needed for multiple replicas.
export function createRateLimit(maximum: number, windowMs: number, key: (req: Parameters<RequestHandler>[0]) => string): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size >= 10000) {
      for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
      if (buckets.size >= 10000) {
        res.set("Retry-After", "60").status(429).json({ error: "Too many requests. Please try again later." }); return;
      }
    }
    const id = key(req);
    const old = buckets.get(id);
    const bucket = old && old.until > now ? old : { count: 0, until: now + windowMs };
    buckets.set(id, bucket);
    bucket.count++;
    if (bucket.count > maximum) {
      req.log?.warn({ event: "rate_limit", operation: req.path }, "Request limit reached");
      res.set("Retry-After", String(Math.ceil((bucket.until - now) / 1000)))
        .status(429).json({ error: "Too many attempts. Please wait and try again." }); return;
    }
    next();
  };
}

const ip = (req: Parameters<RequestHandler>[0]) => req.ip ?? "unknown";
const account = (req: Parameters<RequestHandler>[0]) => createHash("sha256")
  .update(normalizePhilippineMobileNumber(req.body?.mobileNumber) ?? "invalid").digest("hex");
export const loginIpLimit = createRateLimit(30, 15 * 60000, ip);
export const loginAccountLimit = createRateLimit(10, 15 * 60000, account);
export const registrationLimit = createRateLimit(10, 60 * 60000, ip);
export const sensitiveLimit = createRateLimit(120, 60000, ip);
export const referralValidationLimit = createRateLimit(60, 60000, ip);

export const protectMutations: RequestHandler = (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // A browser cannot send this header cross-origin without a successful CORS preflight.
  // The server intentionally does not authorize cross-origin credentialed access.
  if (req.get("X-WealthNova-Request") !== "1" || req.get("Sec-Fetch-Site") === "cross-site") {
    req.log?.warn({ event: "mutation_denied", operation: req.path }, "Request verification rejected");
    res.status(403).json({ error: "Request verification failed. Reload the page and try again." }); return;
  }
  sensitiveLimit(req, res, next);
};

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  next();
};

export const safeErrors: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error?.type === "entity.too.large" ? 413 :
    error?.type === "entity.parse.failed" ? 400 : 500;
  req.log?.error({ event: "request_failed", status }, "API request failed");
  res.status(status).json({ error: status === 413 ? "The request is too large." :
    status === 400 ? "The request could not be read. Please check your details." :
    "Something went wrong. Please try again." });
};
