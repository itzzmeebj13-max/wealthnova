import assert from "node:assert/strict";
import { randomInt, randomUUID, createHash } from "node:crypto";
import express, { type Response } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { Prisma } from "@prisma/client";
import { prisma } from "@workspace/db";
import * as Api from "@workspace/api-zod";
import { startSession } from "./auth-session";
import { createReferralRouter } from "../routes/referrals";
import { getReferralOverview, validateRates } from "./referral-data";
import { decideDeposit } from "./deposit-decisions";
import { collectVerifiedFees, getFundSummary, type ReferralDatabase } from "./referral-finance";
import { createWithdrawalRouter } from "../routes/withdrawals";
import type { WithdrawalDatabase } from "./withdrawals";

const ids: string[] = [];
const cookies: string[] = [];
const rollback = new Error("ROLLBACK_ONLY_REFERRAL_TEST");
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  assert.deepEqual(validateRates(["20", "3", "1"]), [2000, 300, 100]);
  for (const rates of [["-1", "3", "1"], ["100", "3", "1"], ["20.123", "3", "1"], ["NaN", "3", "1"]]) assert.throws(() => validateRates(rates));
  const root = await prisma.user.findUniqueOrThrow({ where: { mobileNumber: "WEALTHNOVA-ROOT" } });
  const originalFund = await prisma.commissionFund.findUniqueOrThrow({ where: { id: "operating" } });
  const originalRates = await prisma.referralRateVersion.count();
  for (let i = 0; i < 5; i++) {
    const user = await prisma.user.create({ data: {
      mobileNumber: `+639${randomInt(0, 1_000_000_000).toString().padStart(9, "0")}`,
      passwordHash: "ROLLBACK_TEST_FIXTURE_NOT_A_LOGIN_PASSWORD", referralCode: `REFTEST-${randomUUID()}`,
      referredBy: i >= 2 ? ids[i - 1] : root.id, role: i === 0 ? "ADMIN" : "USER", wallet: { create: {} },
    } });
    ids.push(user.id);
    let cookie = "";
    await startSession(user.id, { cookie(name: string, value: string) { cookie = `${name}=${value}`; } } as unknown as Response);
    cookies.push(cookie);
  }
  const [admin, tier3, tier2, tier1, investor] = ids;
  try {
    await prisma.$transaction(async tx => {
      // Synthetic balances/proof metadata exist ONLY in this outer transaction.
      await tx.commissionFund.update({ where: { id: "operating" }, data: { availableBalance: 0, reservedBalance: 0 } });
      let scope = 0;
      const scoped = async <T,>(fn: () => Promise<T>) => {
        const label = `referral_scope_${++scope}`;
        await tx.$executeRawUnsafe(`SAVEPOINT ${label}`);
        try { const value = await fn(); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${label}`); return value; }
        catch (e) { await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${label}`); await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${label}`); throw e; }
      };
      const db: ReferralDatabase = {
        user: tx.user, depositRequest: tx.depositRequest, referralCommission: tx.referralCommission, referralRateVersion: tx.referralRateVersion,
        referralNotification: tx.referralNotification, commissionAudit: tx.commissionAudit, companyCapital: tx.companyCapital,
        $transaction: fn => scoped(() => fn(tx)),
      };
      const app = express();
      app.use(express.json(), cookieParser(), pinoHttp({ autoLogging: false }));
      app.use("/api", createReferralRouter(db));
      const withdrawals: WithdrawalDatabase = {
        wallet: tx.wallet, withdrawalRequest: tx.withdrawalRequest, withdrawalAudit: tx.withdrawalAudit,
        withdrawalNotification: tx.withdrawalNotification, $transaction: fn => scoped(() => fn(tx)),
      };
      app.use("/api", createWithdrawalRouter(withdrawals));
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server!.once("listening", resolve));
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}/api`;
      const get = (path: string, cookie = cookies[3]) => fetch(base + path, { headers: { Cookie: cookie } });
      const send = (path: string, body: unknown, cookie = cookies[0], method = "POST", header = true) => fetch(base + path, {
        method, headers: { Cookie: cookie, "Content-Type": "application/json", ...(header ? { "X-WealthNova-Request": "1" } : {}) },
        body: JSON.stringify(body),
      });
      const decision = (id: string, action: string, body = { note: "ROLLBACK-only independently reviewed fixture", confirmed: true }) =>
        send(`/admin/commissions/${id}/${action}`, body);
      const json = async (response: globalThis.Response, status = 200) => {
        const value = await response.json();
        assert.equal(response.status, status, JSON.stringify(value)); return value;
      };
      assert.equal((await get("/admin/commissions", "")).status, 401);
      for (const path of ["/admin/commissions", "/admin/referrals/rates", "/admin/commission-fund"]) {
        assert.equal((await get(path)).status, 403);
      }
      assert.equal((await send("/admin/referrals/rates", {}, cookies[3], "PUT")).status, 403);
      assert.equal((await send("/admin/commission-fund/capital", {}, cookies[3])).status, 403);
      assert.equal((await send("/admin/commission-fund/receipt", {}, cookies[3])).status, 403);
      assert.equal((await send("/admin/referrals/rates", {}, cookies[0], "PUT", false)).status, 403);
      const initialSettings = Api.GetAdminReferralRatesResponse.parse(await json(await get("/admin/referrals/rates", cookies[0])));
      assert.deepEqual([initialSettings.current.tier1, initialSettings.current.tier2, initialSettings.current.tier3], [20, 3, 1]);
      const network = await getReferralOverview(tier3, tx);
      assert.deepEqual([network.tier1Count, network.tier2Count, network.tier3Count, network.totalInvitedUsers], [1, 1, 1, 3]);
      assert.equal(await tx.referralNotification.count({ where: { eventKey: `registration:${investor}`, userId: tier1 } }), 1);
      await assert.rejects(scoped(() => tx.user.update({ where: { id: investor }, data: { referredBy: tier3 } })), /Original referrer cannot be changed/);

      const plan = await tx.investmentPlan.findUniqueOrThrow({ where: { id: "plan-350" } });
      async function purchase(status: "ACTIVE" | "CANCELLED" = "ACTIVE", verified = true, legacy = true) {
        const policy = await tx.referralRateVersion.findUniqueOrThrow({ where: { id: "referral-deposit-policy" } });
        const startDate = legacy ? new Date(policy.effectiveFrom.getTime() - 60000) : new Date();
        const investment = await tx.investment.create({ data: {
          userId: investor, planId: plan.id, principalAmount: plan.principalAmount, dailyAmount: plan.dailyAmount,
          duration: plan.duration, startDate, endDate: new Date(startDate.getTime() + 25 * 86400000),
          idempotencyKey: randomUUID(), status,
        } });
        if (verified) await tx.ledgerEntry.create({ data: {
          userId: investor, investmentId: investment.id, reference: `rollback-purchase:${investment.id}`,
          type: "INVESTMENT_DEBIT", amount: plan.principalAmount, balanceAfter: 0, createdAt: startDate,
        } });
        return investment;
      }
      const unverified = await purchase("ACTIVE", false);
      const cancelled = await purchase("CANCELLED");
      assert.equal(await tx.referralCommission.count({ where: { investmentId: { in: [unverified.id, cancelled.id] } } }), 0);
      const investment = await purchase();
      const commissions = await tx.referralCommission.findMany({ where: { investmentId: investment.id }, orderBy: { tier: "asc" } });
      assert.equal(commissions.length, 3);
      assert.deepEqual(commissions.map(c => [c.tier, c.rateBasisPoints, c.amount.toFixed(2)]),
        [[1, 2000, "70.00"], [2, 300, "10.50"], [3, 100, "3.50"]]);
      assert.deepEqual(commissions.map(c => c.beneficiaryId), [tier1, tier2, tier3]);
      assert.deepEqual((await getReferralOverview(tier1, tx)).commissionTotals,
        { total: "70.00", pending: "70.00", approved: "0.00", rejected: "0.00", paid: "0.00" });
      await tx.$queryRaw`SELECT wealthnova_generate_referral_commissions(${investment.id})::text`;
      assert.equal(await tx.referralCommission.count({ where: { investmentId: investment.id } }), 3);
      assert.equal(await tx.referralNotification.count({ where: { commissionId: { in: commissions.map(c => c.id) } } }), 3);
      assert.equal(await tx.referralNotification.count({ where: { eventKey: { startsWith: `verified:${investment.id}:` } } }), 3);
      assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: tier1 } })).availableBalance.toFixed(2), "0.00");
      const own = Api.GetMyCommissionsResponse.parse(await json(await get(`/referrals/commissions?beneficiaryId=${tier2}`)));
      assert.equal(own.total, 1); assert.ok(own.items.every((c: { beneficiaryId: string }) => c.beneficiaryId === tier1));
      assert.ok(own.items[0].sourceAccount.startsWith("••••"));
      assert.equal((await send(`/admin/commissions/${commissions[0].id}/approve`, { note: "forged authority", confirmed: true }, cookies[3])).status, 403);
      assert.equal((await decision(commissions[0].id, "pay")).status, 409);
      assert.equal((await decision(commissions[0].id, "approve")).status, 409, "No reserve cannot approve or mint wallet money");
      assert.equal((await decision(commissions[0].id, "approve", { note: "confirm required", confirmed: false })).status, 400);
      const cutoverProbe = new Error("ROLLBACK_ONLY_CUTOVER_PROBE");
      await assert.rejects(scoped(async () => {
        const receipt = await tx.depositImage.create({ data: { userId: investor, purpose: "RECEIPT",
          objectPath: `rollback-only/${randomUUID()}`, contentType: "image/png", size: 100, digest: randomUUID() } });
        const d = await tx.depositRequest.create({ data: { userId: investor, amount: "500",
          transactionReference: `CUTOVER${randomInt(10000000, 99999999)}`, receiptImageId: receipt.id,
          receiptDigest: receipt.digest, idempotencyKey: randomUUID(), accountName: "ROLLBACK-only receiver",
          accountNumber: "+639171234567", settingsVersion: 1 } });
        assert.equal(await tx.referralCommission.count({ where: { depositId: d.id } }), 0);
        const approve = { type: "APPROVE" as const, data: { verifiedAmount: "350",
          confirmedPaymentReceived: true, confirmedAmountDifference: true,
          verificationNote: "ROLLBACK-only verified actual 350 rather than requested 500" } };
        const depositDb = { depositRequest: tx.depositRequest, $transaction: <T,>(fn: (t: Prisma.TransactionClient) => Promise<T>) => scoped(() => fn(tx)) };
        await decideDeposit(admin, d.id, approve, depositDb);
        await decideDeposit(admin, d.id, approve, depositDb);
        await tx.$queryRaw`SELECT wealthnova_generate_deposit_commissions(${d.id})::text`;
        const earned = await tx.referralCommission.findMany({ where: { depositId: d.id }, orderBy: { tier: "asc" } });
        assert.deepEqual(earned.map(c => [c.rateBasisPoints, c.basisAmount.toFixed(2), c.amount.toFixed(2)]),
          [[2000, "350.00", "70.00"], [300, "350.00", "10.50"], [100, "350.00", "3.50"]]);
        assert.ok(earned.every(c => c.status === "PENDING" && c.sourceTransactionReference === d.transactionReference));
        assert.equal((await getReferralOverview(tier3, tx)).totalQualifiedReferrals, 1);
        assert.equal((await getReferralOverview(tier1, tx)).totalCommissionsEarned, "0.00");
        assert.equal(await tx.referralNotification.count({ where: { commissionId: { in: earned.map(c => c.id) } } }), 6);
        const newInvestment = await purchase("ACTIVE", true, false);
        assert.equal(await tx.referralCommission.count({ where: { investmentId: newInvestment.id } }), 0);
        const oldDate = new Date((await tx.referralRateVersion.findUniqueOrThrow({ where: { id: "referral-deposit-policy" } })).effectiveFrom.getTime() - 60000);
        const oldReceipt = await tx.depositImage.create({ data: { userId: investor, purpose: "RECEIPT",
          objectPath: `rollback-only/${randomUUID()}`, contentType: "image/png", size: 100, digest: randomUUID() } });
        const old = await tx.depositRequest.create({ data: { userId: investor, amount: "350",
          transactionReference: `OLDDEP${randomInt(10000000, 99999999)}`, receiptImageId: oldReceipt.id,
          receiptDigest: oldReceipt.digest, idempotencyKey: randomUUID(), accountName: "ROLLBACK-only receiver",
          accountNumber: "+639171234567", settingsVersion: 1, status: "APPROVED", approvedAt: oldDate,
          reviewedAt: oldDate, reviewedById: admin, verifiedAmount: "350" } });
        await tx.ledgerEntry.create({ data: { userId: investor, depositRequestId: old.id,
          reference: `deposit:${old.id}`, type: "DEPOSIT_CREDIT", amount: "350", balanceAfter: "350", createdAt: oldDate } });
        await tx.depositDecisionAudit.create({ data: { depositId: old.id, adminId: admin, decision: "APPROVED",
          verifiedAmount: "350", verificationNote: "ROLLBACK-only historical verified fixture", createdAt: oldDate } });
        await tx.$queryRaw`SELECT wealthnova_generate_deposit_commissions(${old.id})::text`;
        assert.equal(await tx.referralCommission.count({ where: { depositId: old.id } }), 0, "Never backfill pre-cutover deposits");
        const rejectedReceipt = await tx.depositImage.create({ data: { userId: investor, purpose: "RECEIPT",
          objectPath: `rollback-only/${randomUUID()}`, contentType: "image/png", size: 100, digest: randomUUID() } });
        const rejected = await tx.depositRequest.create({ data: { userId: investor, amount: "350",
          transactionReference: `REJECTTEST${randomInt(10000000, 99999999)}`, receiptImageId: rejectedReceipt.id,
          receiptDigest: rejectedReceipt.digest, idempotencyKey: randomUUID(), accountName: "ROLLBACK-only receiver",
          accountNumber: "+639171234567", settingsVersion: 1 } });
        await decideDeposit(admin, rejected.id, { type: "REJECT", data: { reason: "ROLLBACK-only unverified source test" } }, depositDb);
        await tx.$queryRaw`SELECT wealthnova_generate_deposit_commissions(${rejected.id})::text`;
        assert.equal(await tx.referralCommission.count({ where: { depositId: rejected.id } }), 0);
        const ownReceipt = await tx.depositImage.create({ data: { userId: admin, purpose: "RECEIPT",
          objectPath: `rollback-only/${randomUUID()}`, contentType: "image/png", size: 100, digest: randomUUID() } });
        const ownDeposit = await tx.depositRequest.create({ data: { userId: admin, amount: "350",
          transactionReference: `SELFDEPOSIT${randomInt(10000000, 99999999)}`, receiptImageId: ownReceipt.id,
          receiptDigest: ownReceipt.digest, idempotencyKey: randomUUID(), accountName: "ROLLBACK-only receiver",
          accountNumber: "+639171234567", settingsVersion: 1 } });
        await assert.rejects(decideDeposit(admin, ownDeposit.id, approve, depositDb), /own deposit/i);
        assert.equal(await tx.referralCommission.count({ where: { depositId: ownDeposit.id } }), 0);
        const version = (await tx.referralRateVersion.findFirstOrThrow({ orderBy: { version: "desc" } })).version;
        await assert.rejects(scoped(() => tx.referralRateVersion.create({ data: { version: version + 1,
          sourceType: "DEPOSIT", tier1BasisPoints: 2500, tier2BasisPoints: 300, tier3BasisPoints: 100,
          effectiveFrom: new Date(), changeReason: "ROLLBACK-only bypass attempt" } })), /20% \/ 3% \/ 1%/);
        const selfId = randomUUID();
        await assert.rejects(scoped(() => tx.user.create({ data: { id: selfId, mobileNumber: `SELF-${selfId}`,
          passwordHash: "ROLLBACK-only", referralCode: `SELF-${selfId}`, referredBy: selfId } })), /Self or circular referral/);
        throw cutoverProbe;
      }), e => e === cutoverProbe);

      const rateInput = { tier1: "20", tier2: "3", tier3: "1", expectedVersion: initialSettings.current.version, reason: "ROLLBACK-only fixed policy confirmation" };
      assert.equal((await send("/admin/referrals/rates", { ...rateInput, tier1: "120" }, cookies[0], "PUT")).status, 400);
      assert.equal((await send("/admin/referrals/rates", { ...rateInput, tier1: "25" }, cookies[0], "PUT")).status, 400);
      const updated = Api.UpdateReferralRatesResponse.parse(await json(await send("/admin/referrals/rates", rateInput, cookies[0], "PUT")));
      assert.deepEqual([updated.current.tier1, updated.current.tier2, updated.current.tier3], [20, 3, 1]);
      assert.equal(updated.current.changedById, admin);
      assert.equal(updated.history[1].version, initialSettings.current.version);
      assert.equal((await send("/admin/referrals/rates", rateInput, cookies[0], "PUT")).status, 409);
      assert.deepEqual((await getReferralOverview(tier3, tx)).rates.map(r => r.percent), [20, 3, 1]);
      const receipt = await tx.depositImage.create({ data: {
        userId: investor, purpose: "RECEIPT", objectPath: `rollback-only/${randomUUID()}`,
        contentType: "image/png", size: 100, digest: randomUUID(),
      } });
      const future = await tx.depositRequest.create({ data: {
        userId: investor, amount: "350", transactionReference: `ROLLBACKDEPOSIT${randomInt(10000000, 99999999)}`,
        receiptImageId: receipt.id, receiptDigest: receipt.digest, idempotencyKey: randomUUID(),
        accountName: "ROLLBACK-only receiver", accountNumber: "+639171234567", settingsVersion: 1,
      } });
      assert.equal(await tx.referralCommission.count({ where: { depositId: future.id } }), 0);
      const approval = { type: "APPROVE" as const, data: { verifiedAmount: "350", confirmedPaymentReceived: true,
        confirmedAmountDifference: false, verificationNote: "ROLLBACK-only independently verified bank fixture" } };
      await decideDeposit(admin, future.id, approval, { depositRequest: tx.depositRequest, $transaction: fn => scoped(() => fn(tx)) });
      await decideDeposit(admin, future.id, approval, { depositRequest: tx.depositRequest, $transaction: fn => scoped(() => fn(tx)) });
      const newer = await tx.referralCommission.findMany({ where: { depositId: future.id }, orderBy: { tier: "asc" } });
      assert.deepEqual(newer.map(c => [c.rateBasisPoints, c.amount.toFixed(2)]), [[2000, "70.00"], [300, "10.50"], [100, "3.50"]]);
      const searched = Api.GetAdminCommissionsResponse.parse(await json(await get(`/admin/commissions?search=${future.id}`, cookies[0])));
      assert.equal(searched.total, 3);
      assert.equal(searched.totalRecordedAmount, (await tx.referralCommission.aggregate({ _sum: { amount: true } }))._sum.amount?.toFixed(2));
      assert.ok(searched.items.every(c => c.depositId === future.id && c.sourceUserId === investor && c.basisAmount === "350.00"));
      const ownDeposits = Api.GetMyCommissionsResponse.parse(await json(await get(`/referrals/commissions?userId=${investor}&beneficiaryId=${tier2}`, cookies[3])));
      assert.equal(ownDeposits.totalRecordedAmount, "140.00");
      assert.ok(ownDeposits.items.every(c => c.beneficiaryId === tier1 && c.sourceUserId === null));
      assert.equal(Api.GetAdminCommissionsResponse.parse(await json(await get(`/admin/commissions?search=${investor}`, cookies[0]))).total, 6);
      assert.equal(Api.GetAdminCommissionsResponse.parse(await json(await get(`/admin/commissions?search=${tier1}`, cookies[0]))).total, 2);
      assert.deepEqual((await tx.referralCommission.findMany({ where: { investmentId: investment.id }, orderBy: { tier: "asc" } })).map(c => c.amount.toFixed(2)), ["70.00", "10.50", "3.50"]);
      await assert.rejects(scoped(() => tx.referralCommission.update({ where: { id: commissions[0].id }, data: { amount: 99 } })), /Historical commission snapshots are immutable/);
      await assert.rejects(scoped(() => tx.referralCommission.update({ where: { id: commissions[0].id }, data: { status: "PAID" } })), /Paid requires a completed funded wallet credit/);
      assert.equal(Api.GetAdminCommissionsResponse.parse(await json(await get("/admin/commissions?search=rollback&status=PENDING", cookies[0]))).total, 6);
      const image = async (owner: string, purpose: "CAPITAL_RECEIPT" | "RECEIPT", seed: string) => tx.depositImage.create({ data: {
        userId: owner, purpose, objectPath: `rollback-only/${randomUUID()}`, contentType: "image/png", size: 100,
        digest: createHash("sha256").update(seed).digest("hex"),
      } });
      const proof = await image(admin, "CAPITAL_RECEIPT", randomUUID());
      const capitalInput = { amount: "1000", transactionReference: `CAP${randomInt(10000000, 99999999)}`, receiptImageId: proof.id,
        verificationNote: "ROLLBACK-only proof fixture; no actual money claimed or persisted.", confirmedCapitalReceived: true, idempotencyKey: randomUUID() };
      assert.equal((await send("/admin/commission-fund/capital", { ...capitalInput, confirmedCapitalReceived: false })).status, 400);
      assert.equal((await send("/admin/commission-fund/capital", { ...capitalInput, receiptImageId: "" })).status, 400);
      await json(await send("/admin/commission-fund/capital", capitalInput));
      await json(await send("/admin/commission-fund/capital", capitalInput));
      assert.equal(await tx.companyCapital.count({ where: { verifiedById: admin } }), 1);
      assert.equal((await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } })).availableBalance.toFixed(2), "1000.00");
      assert.equal((await send("/admin/commission-fund/capital", { ...capitalInput, amount: "1001" })).status, 409);
      assert.equal((await send("/admin/commission-fund/capital", { ...capitalInput, idempotencyKey: randomUUID() })).status, 409);
      const depositImage = await image(investor, "RECEIPT", randomUUID());
      const depositData = { userId: investor, amount: "350", transactionReference: capitalInput.transactionReference,
        receiptImageId: depositImage.id, receiptDigest: depositImage.digest, idempotencyKey: randomUUID(),
        accountName: "ROLLBACK-only receiver", accountNumber: "+639171234567", settingsVersion: 1 };
      await assert.rejects(scoped(() => tx.depositRequest.create({ data: depositData })), /Unique constraint/);
      const pendingDeposit = await tx.depositRequest.create({ data: { ...depositData, transactionReference: `DEP${randomInt(10000000, 99999999)}` } });
      assert.equal(pendingDeposit.status, "PENDING_VERIFICATION");
      assert.equal(await tx.referralCommission.count({ where: { sourceTransactionReference: pendingDeposit.transactionReference } }), 0);
      const duplicateProof = await image(admin, "CAPITAL_RECEIPT", randomUUID());
      assert.equal((await send("/admin/commission-fund/capital", { ...capitalInput, transactionReference: pendingDeposit.transactionReference, receiptImageId: duplicateProof.id, idempotencyKey: randomUUID() })).status, 409);
      await json(await decision(commissions[0].id, "approve"));
      await json(await decision(commissions[0].id, "approve"));
      assert.equal((await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } })).reservedBalance.toFixed(2), "70.00");
      assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: tier1 } })).availableBalance.toFixed(2), "0.00", "Approval is not spendable");
      const reserveShortage = new Error("ROLLBACK_ONLY_RESERVE_SHORTAGE");
      try {
        await scoped(async () => {
          await tx.commissionFund.update({ where: { id: "operating" }, data: { reservedBalance: 0 } });
          const failure = await json(await decision(commissions[0].id, "pay"), 409) as { error: string };
          assert.match(failure.error, /reserved company funding is insufficient/i);
          assert.equal((await tx.referralCommission.findUniqueOrThrow({ where: { id: commissions[0].id } })).status, "APPROVED");
          assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: tier1 } })).availableBalance.toFixed(2), "0.00");
          assert.equal(await tx.ledgerEntry.count({ where: { referralCommissionId: commissions[0].id } }), 0);
          assert.equal(await tx.commissionAudit.count({ where: { commissionId: commissions[0].id, decision: "PAID" } }), 0);
          assert.equal(await tx.referralNotification.count({ where: { eventKey: `commission:${commissions[0].id}:PAID` } }), 0);
          throw reserveShortage;
        });
      } catch (e) { if (e !== reserveShortage) throw e; }
      assert.equal((await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } })).reservedBalance.toFixed(2), "70.00");
      await json(await decision(commissions[0].id, "pay"));
      await json(await decision(commissions[0].id, "pay"));
      assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: tier1 } })).availableBalance.toFixed(2), "70.00");
      assert.equal(await tx.ledgerEntry.count({ where: { referralCommissionId: commissions[0].id } }), 1);
      assert.equal(await tx.commissionAudit.count({ where: { commissionId: commissions[0].id } }), 2);
      assert.equal(await tx.referralNotification.count({ where: { eventKey: `commission:${commissions[0].id}:PAID` } }), 1);
      await json(await decision(commissions[1].id, "approve"));
      await json(await decision(commissions[1].id, "reject", { note: "ROLLBACK-only rejected after review", confirmed: true }));
      await json(await decision(commissions[1].id, "reject"));
      assert.equal((await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } })).availableBalance.toFixed(2), "930.00");
      assert.equal((await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } })).reservedBalance.toFixed(2), "0.00");
      assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: tier2 } })).availableBalance.toFixed(2), "0.00");
      assert.deepEqual((await getReferralOverview(tier1, tx)).commissionTotals,
        { total: "140.00", pending: "70.00", approved: "0.00", rejected: "0.00", paid: "70.00" });
      assert.deepEqual((await getReferralOverview(tier2, tx)).commissionTotals,
        { total: "21.00", pending: "10.50", approved: "0.00", rejected: "10.50", paid: "0.00" });
      await json(await decision(commissions[2].id, "reject"));
      assert.equal((await decision(commissions[2].id, "approve")).status, 409);
      const notification = await tx.referralNotification.findFirstOrThrow({ where: { userId: tier1, type: "COMMISSION_PAID" } });
      assert.equal((await send(`/referrals/notifications/${notification.id}/read`, {}, cookies[2])).status, 404);
      await json(await send(`/referrals/notifications/${notification.id}/read`, {}, cookies[3]));
      assert.ok((await tx.referralNotification.findUniqueOrThrow({ where: { id: notification.id } })).readAt);
      assert.ok(Api.GetReferralNotificationsResponse.parse(await json(await get("/referrals/notifications"))).every(n => n.id !== notification.id));
      for (const status of ["PENDING", "APPROVED", "REJECTED", "PAID"]) {
        const list = Api.GetMyCommissionsResponse.parse(await json(await get(`/referrals/commissions?status=${status}`)));
        assert.ok(list.items.every((c: { status: string; beneficiaryId: string }) => c.status === status && c.beneficiaryId === tier1));
      }
      assert.equal(Api.GetCommissionAuditResponse.parse(await json(await get(`/admin/commissions/${commissions[0].id}/audit`, cookies[0]))).length, 2);
      await tx.ledgerEntry.update({ where: { depositRequestId: future.id }, data: { amount: "99" } });
      assert.equal((await decision(newer[0].id, "approve")).status, 409);
      await tx.wallet.update({ where: { userId: investor }, data: { availableBalance: "2000" } });
      const withdrawal = await json(await send("/withdrawals/requests", {
        amount: "1000", accountName: "ROLLBACK-only fixture", accountNumber: "09171234567", idempotencyKey: randomUUID(),
      }, cookies[4])) as { id: string };
      const beforeFees = await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } });
      await collectVerifiedFees(tx);
      assert.equal((await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } })).availableBalance.toFixed(2), beforeFees.availableBalance.toFixed(2));
      await json(await send(`/admin/withdrawals/${withdrawal.id}/process`, {}));
      await collectVerifiedFees(tx);
      assert.equal((await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } })).availableBalance.toFixed(2), beforeFees.availableBalance.toFixed(2));
      await json(await send(`/admin/withdrawals/${withdrawal.id}/complete`, {
        paidAmount: "950", payoutReference: `FEE${randomInt(10000000, 99999999)}`,
        verificationNote: "ROLLBACK-only fixture; no real payout is sent or persisted.", confirmedPayoutSent: true,
      }));
      await collectVerifiedFees(tx);
      await collectVerifiedFees(tx);
      assert.equal((await tx.commissionFund.findUniqueOrThrow({ where: { id: "operating" } })).availableBalance.toFixed(2), beforeFees.availableBalance.add(50).toFixed(2));
      assert.equal(await tx.companyFundEntry.count({ where: { withdrawalId: withdrawal.id, type: "VERIFIED_FEE" } }), 1);
      assert.equal(await tx.companyFundEntry.count({ where: { type: "VERIFIED_FEE", withdrawal: { status: { not: "COMPLETED" } } } }), 0);
      const summary = await getFundSummary(db);
      assert.equal(summary.totalCapital, "1000.00");
      assert.equal(summary.totalFees, "50.00");
      assert.equal(summary.totalPaid, "70.00");
      assert.equal(summary.availableBalance, "980.00");
      assert.equal(summary.reservedBalance, "0.00");
      assert.ok(summary.entries.some(e => e.type === "VERIFIED_CAPITAL" && e.amount === "1000.00"));
      assert.ok(summary.entries.some(e => e.type === "VERIFIED_FEE" && e.amount === "50.00"));
      console.log("PASS: insufficient approved reserves prevent Paid status, wallet credits, payout audit and notifications; fee/capital funding is tracked separately.");
      console.log("PASS: fixed 20/3/1 deposit rates, rejected outdated 25% writes, Admin IDs/deposit search and recorded totals, private member history/balances, preserved snapshots, future verified deposits, tier ancestry, ownership/Admin/CSRF, duplicate generation/funding/payment/release, source eligibility, actual-event notifications and funded wallet completion.");
      throw rollback;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 90000 });
  } catch (e) { if (e !== rollback) throw e; }
  const fund = await prisma.commissionFund.findUniqueOrThrow({ where: { id: "operating" } });
  assert.equal(fund.availableBalance.toFixed(2), originalFund.availableBalance.toFixed(2));
  assert.equal(fund.reservedBalance.toFixed(2), originalFund.reservedBalance.toFixed(2));
  assert.equal(await prisma.referralRateVersion.count(), originalRates);
  assert.equal(await prisma.referralCommission.count({ where: { sourceUserId: { in: ids } } }), 0);
  assert.equal(await prisma.companyCapital.count({ where: { verifiedById: { in: ids } } }), 0);
  assert.ok((await prisma.wallet.findMany({ where: { userId: { in: ids } } })).every(w => w.availableBalance.isZero() && w.reservedBalance.isZero()));
  console.log("PASS: all synthetic financial changes, source transactions, funding proofs and rate updates rolled back.");
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (ids.length) {
    await prisma.referralNotification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
    for (const id of [...ids].reverse()) await prisma.user.delete({ where: { id } });
  }
  await prisma.$disconnect();
}
