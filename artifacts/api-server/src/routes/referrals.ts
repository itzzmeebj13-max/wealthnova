import { Router, type IRouter, type RequestHandler } from "express";
import multer from "multer";
import * as Api from "@workspace/api-zod";
import { prisma } from "@workspace/db";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middlewares/auth";
import { DepositError, IMAGE_TYPES, MAX_IMAGE_BYTES, storePrivateImage } from "../lib/private-images";
import { getReferralRateSettings, mapCommission, commissionInclude } from "../lib/referral-data";
import { changeReferralRates, decideCommission, getFundSummary, mapCapital, verifyCapital, type ReferralDatabase } from "../lib/referral-finance";

const safe = (fn: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(error => {
    if (error instanceof DepositError) { res.status(error.status).json({ error: error.message }); return; }
    req.log.error({ err: error }, "Referral operation failed");
    res.status(500).json({ error: "Referral operation could not be completed. Please try again." });
  });
};
const admin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== "ADMIN") { res.status(403).json({ error: "Administrator access is required." }); return; }
  next();
};
const mutation: RequestHandler = (req, res, next) => {
  if (req.get("X-WealthNova-Request") !== "1") { res.status(403).json({ error: "Request verification failed." }); return; }
  next();
};
export function createReferralRouter(db: ReferralDatabase = prisma): IRouter {
  const router = Router();
  router.use(["/referrals/commissions", "/referrals/notifications", "/admin/referrals", "/admin/commissions", "/admin/commission-fund"],
    requireAuth, (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  router.use(["/admin/referrals", "/admin/commissions", "/admin/commission-fund"], admin);

  for (const path of ["/referrals/commissions", "/admin/commissions"]) {
    router.get(path, safe(async (req, res) => {
      const isAdmin = path.startsWith("/admin");
      const parsed = Api.GetAdminCommissionsQueryParams.safeParse({
        ...req.query, page: req.query.page === undefined ? 1 : Number(req.query.page),
      });
      if (!parsed.success) throw new DepositError("Please select a valid status, search term and page.");
      const { status, page = 1, search } = parsed.data;
      const term = isAdmin ? search?.trim() : undefined;
      const where: Prisma.ReferralCommissionWhereInput = {
        ...(!isAdmin ? { beneficiaryId: req.user!.id } : {}),
        ...(status && status !== "ALL" ? { status } : {}),
        ...(term ? { OR: [
          { id: { contains: term, mode: "insensitive" } },
          { sourceTransactionReference: { contains: term, mode: "insensitive" } },
          { beneficiary: { mobileNumber: { contains: term } } },
          { sourceUser: { mobileNumber: { contains: term } } },
        ] } : {}),
      };
      const [items, total] = await Promise.all([
        db.referralCommission.findMany({ where, include: commissionInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 20 }),
        db.referralCommission.count({ where }),
      ]);
      res.json(Api.GetMyCommissionsResponse.parse({ items: items.map(c => mapCommission(c, isAdmin)), total, page, pageSize: 20 }));
    }));
  }
  router.get("/admin/referrals/rates", safe(async (_req, res) => {
    res.json(Api.GetAdminReferralRatesResponse.parse(await getReferralRateSettings(db)));
  }));
  router.put("/admin/referrals/rates", mutation, safe(async (req, res) => {
    const body = Api.UpdateReferralRatesBody.safeParse(req.body);
    if (!body.success) throw new DepositError("Please enter three valid percentages, a version and a change reason.");
    await changeReferralRates(req.user!.id, body.data, db);
    res.json(Api.UpdateReferralRatesResponse.parse(await getReferralRateSettings(db)));
  }));
  const decisions = [["approve", "APPROVED"], ["reject", "REJECTED"], ["pay", "PAID"]] as const;
  for (const [action, decision] of decisions) router.post(`/admin/commissions/:commissionId/${action}`, mutation, safe(async (req, res) => {
    const body = Api.ApproveCommissionBody.safeParse(req.body);
    if (!body.success) throw new DepositError("Please provide a decision note and explicit confirmation.");
    const c = await decideCommission(req.user!.id, String(req.params.commissionId), decision, body.data, db);
    res.json(Api.ApproveCommissionResponse.parse(mapCommission(c, true)));
  }));
  router.get("/admin/commissions/:commissionId/audit", safe(async (req, res) => {
    const id = String(req.params.commissionId);
    if (!await db.referralCommission.findUnique({ where: { id }, select: { id: true } })) throw new DepositError("Commission not found.", 404);
    const entries = await db.commissionAudit.findMany({ where: { commissionId: id }, orderBy: { createdAt: "asc" } });
    res.json(Api.GetCommissionAuditResponse.parse(entries.map(e => ({ ...e, createdAt: e.createdAt.toISOString() }))));
  }));
  router.get("/admin/commission-fund", safe(async (_req, res) => {
    res.json(Api.GetCommissionFundResponse.parse(await getFundSummary(db)));
  }));
  router.post("/admin/commission-fund/capital", mutation, safe(async (req, res) => {
    const body = Api.VerifyCompanyCapitalBody.safeParse(req.body);
    if (!body.success) throw new DepositError("Provide a valid amount, transfer reference, private receipt, verification note, confirmation and request key.");
    res.json(Api.VerifyCompanyCapitalResponse.parse(mapCapital(await verifyCapital(req.user!.id, body.data, db))));
  }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1 },
    fileFilter(_req, file, cb) { IMAGE_TYPES.includes(file.mimetype) ? cb(null, true) : cb(new DepositError("Upload a JPEG, PNG or WebP receipt image.")); } });
  const receive: RequestHandler = (req, res, next) => {
    upload.single("file")(req, res, error => {
      if (error) { res.status(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({ error: "Upload one JPEG, PNG or WebP receipt image no larger than 5 MB." }); return; }
      next();
    });
  };
  router.post("/admin/commission-fund/receipt", mutation, receive, safe(async (req, res) => {
    if (!req.file) throw new DepositError("Please select a company-capital receipt image.");
    const image = await storePrivateImage(req.user!.id, "CAPITAL_RECEIPT", req.file.buffer, req.file.mimetype);
    res.json({ id: image.id });
  }));
  router.get("/referrals/notifications", safe(async (req, res) => {
    const items = await db.referralNotification.findMany({ where: { userId: req.user!.id, readAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
    res.json(Api.GetReferralNotificationsResponse.parse(items.map(n => ({ ...n, createdAt: n.createdAt.toISOString() }))));
  }));
  router.post("/referrals/notifications/:notificationId/read", mutation, safe(async (req, res) => {
    const changed = await db.referralNotification.updateMany({ where: { id: String(req.params.notificationId), userId: req.user!.id }, data: { readAt: new Date() } });
    if (changed.count !== 1) throw new DepositError("Notification not found.", 404);
    res.json({ success: true });
  }));
  return router;
}
export default createReferralRouter();
