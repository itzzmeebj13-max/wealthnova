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
  for (let i = 0; i < 4; i++) {
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
        wallet: tx.wallet, withdrawalRequest: tx.withdrawalRequest, withdrawalAudit: tx.withdrawalAudit,
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
      const ownAdminReq = await (await withdraw({ ...input, idempotencyKey: randomUUID() }, cookies[2])).json() as { id: string };
      assert.equal((await action(ownAdminReq.id, "process", {})).status, 403, "No self-review");
      assert.equal((await action(ownAdminReq.id, "reject", reject)).status, 403);
      assert.equal((await action(ownAdminReq.id, "reject", reject, cookies[3])).status, 200);
      assert.equal(await tx.withdrawalAudit.count({ where: { adminId: admin, decision: "COMPLETED" } }), 1);
      throw rollback;
    }, { timeout: 45_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(await prisma.withdrawalRequest.count({ where: { userId: { in: ids } } }), 0);
  assert.equal(await prisma.ledgerEntry.count({ where: { userId: { in: ids } } }), 0);
  assert.equal(await prisma.withdrawalAudit.count({ where: { adminId: { in: ids } } }), 0);
  for (const userId of ids) assert.equal((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).availableBalance.toFixed(2), "0.00");
  process.stdout.write("PASS: 5% fees/rounding; verified balance; gross reservations; duplicate requests; Processing not payout; verified completion; duplicate references/completions; Pending/Processing rejection; exact-once gross release; ledger buckets; audit/notifications; ownership/auth/CSRF; self-review and assigned processor. All financial fixtures rolled back, no actual transfer.\n");
} finally {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
}
