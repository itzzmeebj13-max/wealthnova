import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultDatabase } from "@workspace/db";
import {
  UpdateDepositPaymentSettingsBody, SubmitDepositRequestBody, UploadDepositImageBody,
  GetDepositPaymentSettingsResponse, UpdateDepositPaymentSettingsResponse,
  UploadDepositImageResponse, SubmitDepositRequestResponse, GetMyDepositRequestsResponse,
  GetAdminDepositRequestsQueryParams, GetAdminDepositRequestsResponse,
  ApproveDepositRequestBody, ApproveDepositRequestResponse,
  RejectDepositRequestBody, RejectDepositRequestResponse,
  GetDepositDecisionAuditResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import {
  DepositError, IMAGE_TYPES, MAX_IMAGE_BYTES, storePrivateImage, readPrivateImage,
} from "../lib/private-images";
import { getPaymentSettings, mapPaymentSettings, mapDepositRequest, depositsEnabled, submitDeposit } from "../lib/deposits";
import { saveDepositSettings } from "../lib/deposit-settings";
import { decideDeposit, depositReviewInclude, mapAdminDeposit } from "../lib/deposit-decisions";

type DepositRouteDatabase = Pick<PrismaClient, "depositImage" | "depositPaymentSettings" | "depositRequest" | "depositDecisionAudit" | "$transaction">;
export function createDepositRouter(database: DepositRouteDatabase = defaultDatabase): IRouter {
const prisma = database;
const router: IRouter = Router();
router.use(["/deposits", "/admin/deposits"], requireAuth);
const mutationProtection: RequestHandler = (req, res, next) => {
  // Custom header + credentialed requests prevent form-based cross-origin writes.
  // App CORS does not allow cross-origin credentials.
  if (req.get("X-WealthNova-Request") !== "1") {
    res.status(403).json({ error: "Please submit this request from WealthNova." }); return;
  }
  next();
};
const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== "ADMIN") {
    res.status(403).json({ error: "Administrator access is required." }); return;
  }
  next();
};
function safe(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try { await handler(req, res, next); }
    catch (error) {
      if (error instanceof DepositError) {
        res.status(error.status).json({ error: error.message }); return;
      }
      req.log.error({ err: error }, "Deposit operation failed");
      res.status(503).json({ error: "Deposit service is temporarily unavailable. Please try again." });
    }
  };
}

router.get("/admin/deposits/requests", requireAdmin, safe(async (req, res) => {
  const query = GetAdminDepositRequestsQueryParams.safeParse(req.query);
  if (!query.success) throw new DepositError("Please select a valid status and page.");
  const { status, page, pageSize } = query.data;
  const where: Prisma.DepositRequestWhereInput = status === "ALL" ? {} : { status };
  const [total, records] = await prisma.$transaction([
    prisma.depositRequest.count({ where }),
    prisma.depositRequest.findMany({
      where, include: depositReviewInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize, take: pageSize,
    }),
  ]);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(GetAdminDepositRequestsResponse.parse({
    items: records.map(mapAdminDeposit), total, page, pageSize,
  }));
}));

router.post("/admin/deposits/requests/:depositId/approve", requireAdmin, mutationProtection, safe(async (req, res) => {
  const input = ApproveDepositRequestBody.safeParse(req.body);
  if (!input.success) throw new DepositError("Provide the verified amount, payment confirmation, and verification note.");
  const result = await decideDeposit(req.user!.id, String(req.params.depositId), { type: "APPROVE", data: input.data }, prisma);
  res.json(ApproveDepositRequestResponse.parse({
    deposit: mapAdminDeposit(result.deposit), alreadyProcessed: result.alreadyProcessed,
  }));
}));

router.post("/admin/deposits/requests/:depositId/reject", requireAdmin, mutationProtection, safe(async (req, res) => {
  const input = RejectDepositRequestBody.safeParse(req.body);
  if (!input.success) throw new DepositError("Please provide a rejection reason (5–1000 characters).");
  const result = await decideDeposit(req.user!.id, String(req.params.depositId), { type: "REJECT", data: input.data }, prisma);
  res.json(RejectDepositRequestResponse.parse({
    deposit: mapAdminDeposit(result.deposit), alreadyProcessed: result.alreadyProcessed,
  }));
}));

router.get("/admin/deposits/requests/:depositId/audit", requireAdmin, safe(async (req, res) => {
  const depositId = String(req.params.depositId);
  if (!await prisma.depositRequest.findUnique({ where: { id: depositId }, select: { id: true } })) {
    throw new DepositError("Deposit request not found.", 404);
  }
  const audits = await prisma.depositDecisionAudit.findMany({
    where: { depositId }, include: { admin: { select: { id: true, mobileNumber: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.setHeader("Cache-Control", "private, no-store");
  res.json(GetDepositDecisionAuditResponse.parse(audits.map(audit => ({
    id: audit.id, admin: audit.admin, decision: audit.decision,
    verifiedAmount: audit.verifiedAmount?.toFixed(2) ?? null,
    verificationNote: audit.verificationNote, rejectionReason: audit.rejectionReason,
    amountDifferenceConfirmed: audit.amountDifferenceConfirmed,
    createdAt: audit.createdAt.toISOString(),
  }))));
}));

router.get("/deposits/settings", safe(async (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(GetDepositPaymentSettingsResponse.parse(mapPaymentSettings(await getPaymentSettings(prisma))));
}));

router.put("/admin/deposits/settings", requireAdmin, mutationProtection, safe(async (req, res) => {
  const parsed = UpdateDepositPaymentSettingsBody.safeParse(req.body);
  if (!parsed.success) throw new DepositError("Please check the payment settings and minimum amount.");
  const settings = await saveDepositSettings(req.user!.id, parsed.data, prisma);
  res.json(UpdateDepositPaymentSettingsResponse.parse(mapPaymentSettings(settings)));
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 1, parts: 2 },
  fileFilter(_req, file, cb) {
    if (!IMAGE_TYPES.includes(file.mimetype)) {
      cb(new DepositError("Please upload a JPEG, PNG, or WebP image."));
    } else cb(null, true);
  },
});
const receiveImage: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, error => {
    if (error) {
      const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "Please upload an image no larger than 5 MB." : "Please upload one valid JPEG, PNG, or WebP image.",
      }); return;
    }
    next();
  });
};
router.post("/deposits/images", mutationProtection, receiveImage, safe(async (req, res) => {
  if (!req.file) throw new DepositError("Please select an image.");
  const parsed = UploadDepositImageBody.safeParse({
    purpose: req.body.purpose,
    file: new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }),
  });
  if (!parsed.success) throw new DepositError("Please select a valid image purpose.");
  const user = req.user!;
  if (parsed.data.purpose === "QR" && user.role !== "ADMIN") {
    throw new DepositError("Only administrators can upload payment QR images.", 403);
  }
  if (parsed.data.purpose === "RECEIPT") {
    const settings = await getPaymentSettings(prisma);
    if (!depositsEnabled(settings)) {
      throw new DepositError("Deposit submissions are currently disabled. Please do not send money.", 409);
    }
  }
  const recent = await prisma.depositImage.count({
    where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
  });
  if (recent >= 30) throw new DepositError("Too many image uploads. Please try again later.", 429);
  const image = await storePrivateImage(user.id, parsed.data.purpose, req.file.buffer, req.file.mimetype);
  res.status(201).json(UploadDepositImageResponse.parse({
    id: image.id, url: `/api/deposits/images/${image.id}`, purpose: image.purpose, size: image.size,
  }));
}));

router.get("/deposits/images/:imageId", safe(async (req, res) => {
  const image = await prisma.depositImage.findUnique({ where: { id: String(req.params.imageId) } });
  const settings = image?.purpose === "QR" ? await getPaymentSettings(prisma) : null;
  const permitted = image && (req.user!.role === "ADMIN" || image.userId === req.user!.id ||
    (image.purpose === "QR" && settings?.qrImageId === image.id));
  if (!permitted || !image) { res.status(404).json({ error: "Image not found." }); return; }
  res.set({
    "Content-Type": "image/png", "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Content-Disposition": 'inline; filename="payment-image.png"',
  });
  res.send(await readPrivateImage(image.objectPath));
}));

router.get("/deposits/requests", safe(async (req, res) => {
  const records = await prisma.depositRequest.findMany({
    where: { userId: req.user!.id }, orderBy: { createdAt: "desc" }, take: 100,
  });
  res.setHeader("Cache-Control", "private, no-store");
  res.json(GetMyDepositRequestsResponse.parse(records.map(mapDepositRequest)));
}));
router.post("/deposits/requests", mutationProtection, safe(async (req, res) => {
  const parsed = SubmitDepositRequestBody.safeParse(req.body);
  if (!parsed.success) throw new DepositError("Please enter a valid amount, reference, and receipt.");
  const result = await submitDeposit(req.user!.id, parsed.data, prisma);
  res.status(result.replayed ? 200 : 201).json(SubmitDepositRequestResponse.parse(mapDepositRequest(result.record)));
}));

return router;
}

export default createDepositRouter();
