import { Router, type IRouter, type RequestHandler } from "express";
import { prisma } from "@workspace/db";
import {
  SubmitWithdrawalBody, CompleteWithdrawalBody, RejectWithdrawalBody, GetAdminWithdrawalsQueryParams,
  GetWithdrawalSummaryResponse, GetWithdrawalQuoteResponse, GetMyWithdrawalsResponse,
  SubmitWithdrawalResponse, GetAdminWithdrawalsResponse, ProcessWithdrawalResponse,
  CompleteWithdrawalResponse, RejectWithdrawalResponse, GetWithdrawalAuditResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { DepositError } from "../lib/private-images";
import { requestWithdrawal, withdrawalAmounts, withdrawalInclude, mapWithdrawal, withdrawalSummary, type WithdrawalDatabase } from "../lib/withdrawals";
import { decideWithdrawal } from "../lib/withdrawal-decisions";

const adminOnly: RequestHandler = (req, res, next) => {
  if (req.user?.role !== "ADMIN") { res.status(403).json({ error: "Administrator access is required." }); return; }
  next();
};
const mutation: RequestHandler = (req, res, next) => {
  if (req.get("X-WealthNova-Request") !== "1") { res.status(403).json({ error: "Submit this request from WealthNova." }); return; }
  next();
};
const safe = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  try { await handler(req, res, next); }
  catch (error) {
    if (error instanceof DepositError) { res.status(error.status).json({ error: error.message }); return; }
    req.log.error({ err: error }, "Withdrawal operation failed");
    res.status(503).json({ error: "Withdrawal service unavailable. Retry the same request safely." });
  }
};
export function createWithdrawalRouter(database: WithdrawalDatabase = prisma): IRouter {
  const router = Router();
  router.use(["/withdrawals", "/admin/withdrawals"], requireAuth);
  router.get("/withdrawals/summary", safe(async (req, res) => {
    res.json(GetWithdrawalSummaryResponse.parse(await withdrawalSummary(req.user!.id, database)));
  }));
  router.get("/withdrawals/quote", safe(async (req, res) => {
    const { amount, fee, net } = withdrawalAmounts(String(req.query.amount ?? ""));
    res.json(GetWithdrawalQuoteResponse.parse({ requestedAmount: amount.toFixed(2), feeAmount: fee.toFixed(2), netAmount: net.toFixed(2), feePercent: 5 }));
  }));
  router.get("/withdrawals/requests", safe(async (req, res) => {
    const rows = await database.withdrawalRequest.findMany({
      where: { userId: req.user!.id }, include: withdrawalInclude, orderBy: { createdAt: "desc" }, take: 100,
    });
    res.json(GetMyWithdrawalsResponse.parse(rows.map(mapWithdrawal)));
  }));
  router.post("/withdrawals/requests", mutation, safe(async (req, res) => {
    const input = SubmitWithdrawalBody.safeParse(req.body);
    if (!input.success) throw new DepositError("Enter a valid amount, GCash account name, Philippine number, and retry key.");
    res.json(SubmitWithdrawalResponse.parse(mapWithdrawal(await requestWithdrawal(req.user!.id, input.data, database))));
  }));
  router.post("/withdrawals/notifications/:notificationId/read", mutation, safe(async (req, res) => {
    const changed = await database.withdrawalNotification.updateMany({
      where: { id: String(req.params.notificationId), userId: req.user!.id }, data: { readAt: new Date() },
    });
    if (!changed.count) throw new DepositError("Notification not found.", 404);
    res.json({ success: true });
  }));
  router.get("/admin/withdrawals", adminOnly, safe(async (req, res) => {
    const input = GetAdminWithdrawalsQueryParams.safeParse(req.query);
    if (!input.success) throw new DepositError("Select a valid withdrawal status and page.");
    const { status = "PENDING", page = 1 } = input.data;
    const where = status === "ALL" ? {} : { status };
    const [items, total] = await database.$transaction(tx => Promise.all([
      tx.withdrawalRequest.findMany({ where, include: withdrawalInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 20 }),
      tx.withdrawalRequest.count({ where }),
    ]));
    res.json(GetAdminWithdrawalsResponse.parse({ items: items.map(mapWithdrawal), total, page, pageSize: 20 }));
  }));
  router.post("/admin/withdrawals/:withdrawalId/process", adminOnly, mutation, safe(async (req, res) => {
    res.json(ProcessWithdrawalResponse.parse(mapWithdrawal(await decideWithdrawal(req.user!.id, String(req.params.withdrawalId), { type: "PROCESS" }, database))));
  }));
  router.post("/admin/withdrawals/:withdrawalId/complete", adminOnly, mutation, safe(async (req, res) => {
    const input = CompleteWithdrawalBody.safeParse(req.body);
    if (!input.success) throw new DepositError("Enter the actual payout reference, paid amount, confirmation, and verification note.");
    res.json(CompleteWithdrawalResponse.parse(mapWithdrawal(await decideWithdrawal(req.user!.id, String(req.params.withdrawalId), { type: "COMPLETE", data: input.data }, database))));
  }));
  router.post("/admin/withdrawals/:withdrawalId/reject", adminOnly, mutation, safe(async (req, res) => {
    const input = RejectWithdrawalBody.safeParse(req.body);
    if (!input.success) throw new DepositError("Enter a rejection reason and confirm no payout was sent.");
    res.json(RejectWithdrawalResponse.parse(mapWithdrawal(await decideWithdrawal(req.user!.id, String(req.params.withdrawalId), { type: "REJECT", data: input.data }, database))));
  }));
  router.get("/admin/withdrawals/:withdrawalId/audit", adminOnly, safe(async (req, res) => {
    const rows = await database.withdrawalAudit.findMany({ where: { withdrawalId: String(req.params.withdrawalId) }, orderBy: { createdAt: "asc" } });
    res.json(GetWithdrawalAuditResponse.parse(rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }))));
  }));
  return router;
}
export default createWithdrawalRouter();
