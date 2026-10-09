import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import express, { type Response } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { Prisma } from "@prisma/client";
import { prisma } from "@workspace/db";
import { startSession } from "./auth-session";
import { createWithdrawalRouter } from "../routes/withdrawals";
import { withdrawalAmounts, type WithdrawalDatabase } from "./withdrawals";
import { handoffWithdrawal } from "./withdrawal-handoffs";

const ids: string[] = [];
const rollback = new Error("ROLLBACK_ONLY_WITHDRAWAL_TEST");
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  const thousand = withdrawalAmounts("1000");
  assert.equal(thousand.fee.toFixed(2), "50.00");
  assert.equal(thousand.net.toFixed(2), "950.00");
  assert.equal(withdrawalAmounts("0.10").fee.toFixed(2), "0.01", "Fees round half-up to cents");
  for (const invalid of ["0", "-1", "1.001", "NaN", "1e3"]) assert.throws(() => withdrawalAmounts(invalid));
  const root = await prisma.user.findUniqueOrThrow({ where: { mobileNumber: "WEALTHNOVA-ROOT" } });
  const cookies: string[] = [];
  for (let i = 0; i < 5; i++) {
    const user = await prisma.user.create({ data: {
      mobileNumber: `+639${randomInt(0, 1_000_000_000).toString().padStart(9, "0")}`,
      passwordHash: "ROLLBACK_TEST_FIXTURE_NOT_A_LOGIN_PASSWORD", referralCode: `WDTEST-${randomUUID()}`,
      referredBy: root.id, role: i < 2 ? "USER" : "ADMIN", wallet: { create: {} },
    } });
    ids.push(user.id);
    let cookie = "";
    await startSession(user.id, { cookie(name: string, value: string) { cookie = `${name}=${value}`; } } as unknown as Response);
    cookies.push(cookie);
  }
  const [owner, other, admin] = ids;
  try {
    await prisma.$transaction(async tx => {
      for (const userId of ids) {
        await tx.wallet.update({ where: { userId }, data: { availableBalance: "3000.00" } });
        await tx.ledgerEntry.create({ data: {
          userId, type: "DEPOSIT_CREDIT", reference: `rollback-fixture:${userId}`,
          amount: "3000.00", balanceAfter: "3000.00",
        } });
      }
      let scope = 0;
      const db: WithdrawalDatabase = {
        wallet: tx.wallet, withdrawalRequest: tx.withdrawalRequest, withdrawalAudit: tx.withdrawalAudit, withdrawalHandoff: tx.withdrawalHandoff,
        withdrawalNotification: tx.withdrawalNotification,
        $transaction: async fn => {
          // Each HTTP operation gets real rollback semantics inside the outer,
          // rollback-only fixture transaction; labels never contain user input.
          const label = `withdrawal_scope_${++scope}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${label}`);
          try {
            const result = await fn(tx);
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${label}`);
            return result;
          } catch (error) {
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${label}`);
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${label}`);
            throw error;
          }
        },
      };
      const app = express();
      app.use(express.json(), cookieParser(), pinoHttp({
        autoLogging: false, serializers: { req: r => ({ method: r.method, url: r.url?.split("?")[0] }), res: r => ({ statusCode: r.statusCode }) },
      }));
      app.use("/api", createWithdrawalRouter(db));
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server!.once("listening", resolve));
      const addr = server.address();
      assert.ok(addr && typeof addr !== "string");
      const base = `http://127.0.0.1:${addr.port}/api`;
      const get = (path: string, cookie = cookies[0]) => fetch(base + path, { headers: { Cookie: cookie } });
      const post = (path: string, body: unknown, cookie = cookies[0], header = true) => fetch(base + path, {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", ...(header ? { "X-WealthNova-Request": "1" } : {}) },
        body: JSON.stringify(body),
      });
      const input = { amount: "1000", accountName: "ROLLBACK TEST ONLY", accountNumber: "09171234567", idempotencyKey: randomUUID() };
      const withdraw = (body: unknown, cookie = cookies[0]) => post("/withdrawals/requests", body, cookie);
      const action = (id: string, type: string, body: unknown, cookie = cookies[2]) => post(`/admin/withdrawals/${id}/${type}`, body, cookie);
      const complete = { payoutReference: `ROLLBACKPAYOUT${randomInt(100000, 999999)}`, paidAmount: "950.00", confirmedPayoutSent: true, verificationNote: "ROLLBACK TEST ONLY — no actual transfer occurred." };
      const reject = { reason: "ROLLBACK TEST ONLY — payout not sent.", confirmedNoPayoutSent: true };
      const wallet = () => tx.wallet.findUniqueOrThrow({ where: { userId: owner } });
      assert.equal((await get("/withdrawals/summary", "")).status, 401);
      assert.equal((await get("/admin/withdrawals")).status, 403);
      assert.equal((await post("/withdrawals/requests", input, cookies[0], false)).status, 403);
      assert.equal((await withdraw(input, "")).status, 401);
      assert.equal((await withdraw({ ...input, accountNumber: "+14155550123" })).status, 400);
      assert.equal((await withdraw({ ...input, accountName: "  " })).status, 400);
      assert.equal((await withdraw({ ...input, amount: "3000.01" })).status, 409);
      assert.equal(await tx.withdrawalRequest.count({ where: { userId: owner } }), 0);
      const quote = await get("/withdrawals/quote?amount=1000");
      assert.deepEqual(await quote.json(), { requestedAmount: "1000.00", feeAmount: "50.00", netAmount: "950.00", feePercent: 5 });
      const created = await withdraw({ ...input, userId: other, feeAmount: "0", netAmount: "9999" });
      assert.equal(created.status, 200);
      const request = await created.json() as { id: string; status: string; userId: string; feeAmount: string; netAmount: string; accountNumber: string };
      assert.equal(request.status, "PENDING"); assert.equal(request.userId, owner);
      assert.equal(request.feeAmount, "50.00"); assert.equal(request.netAmount, "950.00");
      assert.equal(request.accountNumber, "+639171234567");
      assert.equal((await wallet()).availableBalance.toFixed(2), "2000.00");
      assert.equal((await wallet()).reservedBalance.toFixed(2), "1000.00");
      assert.equal((await wallet()).activeWithdrawalId, request.id);
      assert.equal(await tx.ledgerEntry.count({ where: { withdrawalId: request.id } }), 2);
      assert.equal((await withdraw(input)).status, 200);
      assert.equal((await withdraw({ ...input, idempotencyKey: randomUUID() })).status, 409);
      assert.equal((await withdraw({ ...input, amount: "2000" })).status, 409);
      assert.equal(await tx.withdrawalRequest.count({ where: { userId: owner } }), 1);
      assert.equal((await tx.wallet.updateMany({
        where: { userId: owner, availableBalance: { gte: "2000.01" } }, data: { availableBalance: { decrement: "2000.01" } },
      })).count, 0, "Reserved funds are not spendable");
      assert.equal((await action(request.id, "process", {}, cookies[0])).status, 403);
      assert.equal((await action(request.id, "complete", complete, cookies[0])).status, 403);
      assert.equal((await action(request.id, "reject", reject, cookies[0])).status, 403);
      assert.equal((await action(request.id, "complete", complete)).status, 409, "PENDING is not a payout approval");
      assert.equal((await action(request.id, "process", {})).status, 200);
      assert.equal((await action(request.id, "process", {})).status, 200);
      assert.equal((await action(request.id, "process", {}, cookies[3])).status, 409);
      assert.equal(await tx.withdrawalAudit.count({ where: { withdrawalId: request.id } }), 1);
      assert.equal((await wallet()).reservedBalance.toFixed(2), "1000.00");
      assert.equal((await action(request.id, "complete", { ...complete, confirmedPayoutSent: false })).status, 400);
      assert.equal((await action(request.id, "complete", { ...complete, paidAmount: "900" })).status, 400);
      assert.equal((await action(request.id, "complete", complete, cookies[3])).status, 409);
      await tx.wallet.update({ where: { userId: owner }, data: { activeWithdrawalId: "ROLLBACK_MISMATCH" } });
      assert.equal((await action(request.id, "complete", complete)).status, 409);
      assert.equal((await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: request.id } })).status, "PROCESSING", "A reserve mismatch must roll back the decision");
      assert.equal(await tx.ledgerEntry.count({ where: { withdrawalId: request.id } }), 2);
      await tx.wallet.update({ where: { userId: owner }, data: { activeWithdrawalId: request.id } });
      assert.equal((await action(request.id, "complete", complete)).status, 200);
      assert.equal((await action(request.id, "complete", complete)).status, 200);
      assert.equal((await action(request.id, "complete", { ...complete, payoutReference: "DIFFERENTREFERENCE" })).status, 409);
      assert.equal((await action(request.id, "reject", reject)).status, 409);
      assert.equal((await wallet()).availableBalance.toFixed(2), "2000.00", "Payout must not deduct available balance again");
      assert.equal((await wallet()).reservedBalance.toFixed(2), "0.00");
      assert.equal((await wallet()).activeWithdrawalId, null);
      const payout = await tx.ledgerEntry.findUniqueOrThrow({ where: { reference: `withdrawal:${request.id}:payout` } });
      assert.equal(payout.amount.toFixed(2), "-950.00"); assert.equal(payout.balanceBucket, "RESERVED");
      assert.equal((await tx.ledgerEntry.findUniqueOrThrow({ where: { reference: `withdrawal:${request.id}:fee` } })).amount.toFixed(2), "-50.00");
      assert.equal(await tx.ledgerEntry.count({ where: { withdrawalId: request.id } }), 4);
      assert.equal((await withdraw(input)).status, 200, "Terminal submission replay must not reserve again");
      const rejectedInput = { ...input, amount: "500", idempotencyKey: randomUUID() };
      const pendingReject = await (await withdraw(rejectedInput)).json() as { id: string };
      assert.equal((await action(pendingReject.id, "reject", { ...reject, reason: " " })).status, 400);
      assert.equal((await action(pendingReject.id, "reject", { ...reject, confirmedNoPayoutSent: false })).status, 400);
      assert.equal((await action(pendingReject.id, "reject", reject)).status, 200);
      assert.equal((await action(pendingReject.id, "reject", reject)).status, 200);
      assert.equal((await wallet()).availableBalance.toFixed(2), "2000.00");
      assert.equal((await wallet()).reservedBalance.toFixed(2), "0.00");
      assert.equal(await tx.ledgerEntry.count({ where: { withdrawalId: pendingReject.id, type: "WITHDRAWAL_RELEASE" } }), 1);
      assert.equal(await tx.withdrawalAudit.count({ where: { withdrawalId: pendingReject.id } }), 1);
      const notifications = await tx.withdrawalNotification.findMany({ where: { withdrawalId: pendingReject.id } });
      assert.equal(notifications.length, 1); assert.match(notifications[0].message, /500.00/);
      assert.equal((await post(`/withdrawals/notifications/${notifications[0].id}/read`, {}, cookies[1])).status, 404);
      assert.equal((await post(`/withdrawals/notifications/${notifications[0].id}/read`, {})).status, 200);
      const history = await (await get("/withdrawals/requests")).json() as { id: string; status: string }[];
      assert.ok(history.some(r => r.id === pendingReject.id && r.status === "REJECTED"));
      assert.deepEqual(await (await get("/withdrawals/requests", cookies[1])).json(), []);
      assert.equal((await get("/admin/withdrawals?status=ALL&page=1", cookies[2])).status, 200);
      assert.equal((await get(`/admin/withdrawals/${request.id}/audit`, cookies[0])).status, 403);
      assert.equal((await get(`/admin/withdrawals/${request.id}/audit`, cookies[2])).status, 200);
      const otherReq = await (await withdraw({ ...input, idempotencyKey: randomUUID() }, cookies[1])).json() as { id: string };
      assert.equal((await action(otherReq.id, "process", {})).status, 200);
      assert.equal((await action(otherReq.id, "complete", complete)).status, 409, "Payout references cannot be reused");
      assert.equal((await action(otherReq.id, "reject", reject)).status, 200, "Processing rejection releases funds too");
      const handoffReq = await (await withdraw({ ...input, amount: "500", idempotencyKey: randomUUID() })).json() as { id: string };
      const handoffInput = (record: { processingById: string | null; updatedAt: Date }) => ({
        expectedProcessorId: record.processingById!, expectedUpdatedAt: record.updatedAt.toISOString(),
        payoutStatus: "NOT_SENT" as const, confirmedPreviousProcessorStopped: true,
        reconciliationNote: "ROLLBACK TEST: custodian checked history, no pending/successful transfer; previous processor access stopped.",
      });
      const pendingHandoff = { ...handoffInput({ processingById: admin, updatedAt: new Date() }) };
      assert.equal((await action(handoffReq.id, "handoff", pendingHandoff, cookies[3])).status, 409, "Only Processing requests can be handed off");
      assert.equal((await action(handoffReq.id, "process", {})).status, 200);
      const original = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: handoffReq.id } });
      const handoff = handoffInput(original);
      const fundsBefore = await wallet();
      const ledgerBefore = await tx.ledgerEntry.count({ where: { withdrawalId: handoffReq.id } });
      assert.equal((await action(handoffReq.id, "handoff", handoff, "")).status, 401);
      assert.equal((await action(handoffReq.id, "handoff", handoff, cookies[0])).status, 403);
      assert.equal((await post(`/admin/withdrawals/${handoffReq.id}/handoff`, handoff, cookies[3], false)).status, 403);
      await tx.user.update({ where: { id: ids[3] }, data: { status: "SUSPENDED" } });
      assert.equal((await action(handoffReq.id, "handoff", handoff, cookies[3])).status, 403, "Active Admin rechecked inside transaction");
      await tx.user.update({ where: { id: ids[3] }, data: { status: "ACTIVE", role: "USER" } });
      await assert.rejects(handoffWithdrawal(ids[3], handoffReq.id, { ...handoff, expectedUpdatedAt: new Date(handoff.expectedUpdatedAt) }, db), /Active Administrator/);
      await tx.user.update({ where: { id: ids[3] }, data: { role: "ADMIN" } });
      assert.equal((await action(handoffReq.id, "handoff", handoff)).status, 409, "Current processor cannot hand off to themselves");
      for (const invalid of [
        { ...handoff, confirmedPreviousProcessorStopped: false },
        { ...handoff, payoutStatus: "UNKNOWN" },
        { ...handoff, reconciliationNote: " ".repeat(20) },
        { ...handoff, payoutStatus: "SENT" },
        { ...handoff, payoutStatus: "NOT_SENT", payoutReference: "UNEXPECTED" },
      ]) assert.equal((await action(handoffReq.id, "handoff", invalid, cookies[3])).status, 400);
      assert.equal((await action(handoffReq.id, "handoff", { ...handoff, expectedProcessorId: ids[4] }, cookies[3])).status, 409);
      assert.equal((await action(handoffReq.id, "handoff", { ...handoff, expectedUpdatedAt: new Date(original.updatedAt.getTime() - 1).toISOString() }, cookies[3])).status, 409, "Stale version is rejected even with matching processor");
      assert.equal((await action(handoffReq.id, "handoff", handoff, cookies[3])).status, 200);
      // Competing recipient's stale snapshot must lose, not steal the review.
      assert.equal((await action(handoffReq.id, "handoff", handoff, cookies[4])).status, 409);
      assert.equal((await action(handoffReq.id, "handoff", handoff, cookies[3])).status, 409, "Replay adds no new handoff or financial effect");
      const transferred = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: handoffReq.id } });
      assert.equal(transferred.processingById, ids[3]); assert.equal(transferred.status, "PROCESSING");
      assert.equal(transferred.processedAt!.toISOString(), original.processedAt!.toISOString());
      assert.equal((await wallet()).availableBalance.toFixed(2), fundsBefore.availableBalance.toFixed(2));
      assert.equal((await wallet()).reservedBalance.toFixed(2), fundsBefore.reservedBalance.toFixed(2));
      assert.equal((await wallet()).activeWithdrawalId, handoffReq.id);
      assert.equal(await tx.ledgerEntry.count({ where: { withdrawalId: handoffReq.id } }), ledgerBefore);
      assert.equal(await tx.withdrawalAudit.count({ where: { withdrawalId: handoffReq.id } }), 1);
      assert.equal(await tx.withdrawalNotification.count({ where: { withdrawalId: handoffReq.id } }), 1);
      assert.equal((await action(handoffReq.id, "complete", { ...complete, paidAmount: "475" })).status, 409);
      assert.equal((await action(handoffReq.id, "reject", reject)).status, 409, "Old processor cannot release funds");
      const sentHandoff = { ...handoffInput(transferred), payoutStatus: "SENT" as const, payoutReference: `HANDOFF${randomUUID().replaceAll("-", "").toUpperCase()}`, paidAmount: "475.00" };
      assert.equal((await action(handoffReq.id, "handoff", { ...sentHandoff, payoutReference: complete.payoutReference }, cookies[4])).status, 409);
      assert.equal((await action(handoffReq.id, "handoff", { ...sentHandoff, paidAmount: "470" }, cookies[4])).status, 400);
      assert.equal((await action(handoffReq.id, "handoff", sentHandoff, cookies[4])).status, 200);
      const sentRecord = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: handoffReq.id } });
      assert.equal(sentRecord.payoutReference, sentHandoff.payoutReference);
      assert.equal(sentRecord.status, "PROCESSING");
      assert.equal((await action(handoffReq.id, "reject", reject, cookies[4])).status, 409, "Already-sent payment cannot be refunded");
      assert.equal((await action(handoffReq.id, "handoff", handoffInput(sentRecord), cookies[3])).status, 409, "Already-sent payment evidence cannot be removed");
      assert.equal((await action(handoffReq.id, "handoff", { ...handoffInput(sentRecord), payoutStatus: "SENT", paidAmount: "475", payoutReference: "DIFFERENTREF" }, cookies[3])).status, 409);
      const sentComplete = { ...complete, payoutReference: sentHandoff.payoutReference, paidAmount: "475" };
      assert.equal((await action(handoffReq.id, "complete", { ...sentComplete, payoutReference: "DIFFERENTREF" }, cookies[4])).status, 409);
      assert.equal((await action(handoffReq.id, "complete", sentComplete, cookies[3])).status, 409);
      assert.equal((await action(handoffReq.id, "complete", sentComplete, cookies[4])).status, 200);
      assert.equal((await action(handoffReq.id, "complete", sentComplete, cookies[4])).status, 200);
      assert.equal((await action(handoffReq.id, "handoff", sentHandoff, cookies[3])).status, 409, "Final records cannot be handed off");
      assert.equal(await tx.ledgerEntry.count({ where: { withdrawalId: handoffReq.id } }), 4, "Handoff plus completion has exact-once financial effects");
      assert.equal(await tx.withdrawalHandoff.count({ where: { withdrawalId: handoffReq.id } }), 2);
      const combinedAudit = await (await get(`/admin/withdrawals/${handoffReq.id}/audit`, cookies[4])).json() as { decision: string; fromAdminId?: string; toAdminId?: string; payoutStatus?: string }[];
      assert.equal(combinedAudit.length, 4, "Original processing, both handoffs, and completion preserved");
      assert.ok(combinedAudit.some(a => a.decision === "REASSIGNED" && a.fromAdminId === ids[3] && a.toAdminId === ids[4] && a.payoutStatus === "SENT"));
      const unsentReq = await (await withdraw({ ...input, amount: "100", idempotencyKey: randomUUID() })).json() as { id: string };
      assert.equal((await action(unsentReq.id, "process", {})).status, 200);
      const unsentRecord = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: unsentReq.id } });
      assert.equal((await action(unsentReq.id, "handoff", handoffInput(unsentRecord), cookies[3])).status, 200);
      const unsentTransferred = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: unsentReq.id } });
      assert.equal((await action(unsentReq.id, "handoff", handoffInput(unsentTransferred))).status, 200, "Repeated coordinated handoffs preserve history");
      assert.equal((await action(unsentReq.id, "handoff", handoffInput(unsentRecord), cookies[4])).status, 409, "Returning to same processor cannot revive an old snapshot");
      assert.equal((await action(unsentReq.id, "reject", reject, cookies[3])).status, 409);
      const balanceBeforeRelease = await wallet();
      assert.equal((await action(unsentReq.id, "reject", reject)).status, 200);
      assert.equal((await action(unsentReq.id, "reject", reject)).status, 200);
      assert.equal((await wallet()).availableBalance.toFixed(2), balanceBeforeRelease.availableBalance.plus(100).toFixed(2));
      assert.equal(await tx.ledgerEntry.count({ where: { withdrawalId: unsentReq.id, type: "WITHDRAWAL_RELEASE" } }), 1);
      assert.equal(await tx.withdrawalHandoff.count({ where: { withdrawalId: unsentReq.id } }), 2);
      const ownAdminReq = await (await withdraw({ ...input, idempotencyKey: randomUUID() }, cookies[2])).json() as { id: string };
      assert.equal((await action(ownAdminReq.id, "process", {})).status, 403, "No self-review");
      assert.equal((await action(ownAdminReq.id, "reject", reject)).status, 403);
      assert.equal((await action(ownAdminReq.id, "process", {}, cookies[3])).status, 200);
      const ownRecord = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: ownAdminReq.id } });
      assert.equal((await action(ownAdminReq.id, "handoff", handoffInput(ownRecord))).status, 403, "No self-review during takeover");
      assert.equal((await action(ownAdminReq.id, "reject", reject, cookies[3])).status, 200);
      assert.equal(await tx.withdrawalAudit.count({ where: { adminId: admin, decision: "COMPLETED" } }), 1);
      throw rollback;
    }, { timeout: 45_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(await prisma.withdrawalRequest.count({ where: { userId: { in: ids } } }), 0);
  assert.equal(await prisma.ledgerEntry.count({ where: { userId: { in: ids } } }), 0);
  assert.equal(await prisma.withdrawalAudit.count({ where: { adminId: { in: ids } } }), 0);
  assert.equal(await prisma.withdrawalHandoff.count({ where: { toAdminId: { in: ids } } }), 0);
  for (const userId of ids) assert.equal((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).availableBalance.toFixed(2), "0.00");
  process.stdout.write("PASS: withdrawal accounting/auth; reconciled handoff permissions, conflicts/replays, retained reserves/history, previous processor blocked, already-sent evidence locked, exact-once completion, no self-review. All financial fixtures rolled back, no actual transfer.\n");
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
}
