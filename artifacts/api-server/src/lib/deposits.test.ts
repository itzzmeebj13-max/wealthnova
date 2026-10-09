import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Response } from "express";
import { prisma } from "@workspace/db";
import app from "../app";
import { startSession, SESSION_COOKIE } from "./auth-session";
import { getPaymentSettings, submitDeposit } from "./deposits";
import { decideDeposit } from "./deposit-decisions";
import { Prisma } from "@prisma/client";
import { sanitizeImage, storePrivateImage, deletePrivateImage, DepositError } from "./private-images";

const users: string[] = [];
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Test server unavailable.");
const base = `http://127.0.0.1:${address.port}/api`;
const fixture = await readFile("../../attached_assets/IMG_20261007_232230_1791510095107.jpg");
async function session(userId: string) {
  let cookie = "";
  await startSession(userId, {
    cookie(name: string, value: string) { cookie = `${name}=${value}`; },
  } as unknown as Response);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  return cookie;
}
async function upload(cookie: string, purpose: string, bytes: Buffer, mime = "image/jpeg") {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), "image");
  return fetch(`${base}/deposits/images`, {
    method: "POST", headers: { Cookie: cookie, "X-WealthNova-Request": "1" }, body: form,
  });
}
const errorStatus = (status: number) => (error: unknown) => error instanceof DepositError && error.status === status;
const rollback = new Error("ROLLBACK_TEST_ONLY");
try {
  const original = await getPaymentSettings();
  assert.equal(original.submissionsEnabled, false, "Tests must not enable real deposits");
  const root = await prisma.user.findUniqueOrThrow({ where: { mobileNumber: "WEALTHNOVA-ROOT" } });
  for (const role of ["ADMIN", "USER", "USER"] as const) {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        mobileNumber: `TEST-DEPOSIT-${suffix}`, passwordHash: "disabled-test-fixture",
        referralCode: `TEST-${suffix}`, referredBy: root.id, role,
        wallet: { create: {} },
      },
    });
    users.push(user.id);
  }
  const [adminId, ownerId, otherId] = users as [string, string, string];
  const adminCookie = await session(adminId);
  const ownerCookie = await session(ownerId);
  const otherCookie = await session(otherId);
  assert.equal((await fetch(`${base}/admin/deposits/requests`)).status, 401);
  assert.equal((await fetch(`${base}/admin/deposits/requests`, { headers: { Cookie: ownerCookie } })).status, 403);
  const approvalInput = {
    verifiedAmount: "100.00", confirmedPaymentReceived: true,
    confirmedAmountDifference: false,
    verificationNote: "UNCOMMITTED TEST ONLY — no actual payment",
  };
  for (const action of ["approve", "reject"]) {
    assert.equal((await fetch(`${base}/admin/deposits/requests/not-a-deposit/${action}`, {
      method: "POST",
      headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-WealthNova-Request": "1" },
      body: JSON.stringify(action === "approve" ? approvalInput : { reason: "Test rejection reason" }),
    })).status, 403);
  }
  assert.equal((await fetch(`${base}/admin/deposits/requests/not-a-deposit/approve`, {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json", "X-WealthNova-Request": "1" },
    body: JSON.stringify({ ...approvalInput, confirmedPaymentReceived: false }),
  })).status, 400);
  assert.equal((await fetch(`${base}/deposits/settings`)).status, 401);
  assert.equal((await upload(ownerCookie, "QR", fixture)).status, 403);
  assert.equal((await upload(ownerCookie, "RECEIPT", fixture)).status, 409);
  assert.equal((await upload(adminCookie, "QR", Buffer.from("not an image"), "image/png")).status, 400);
  assert.equal((await upload(adminCookie, "QR", fixture, "image/svg+xml")).status, 400);
  assert.equal((await upload(adminCookie, "QR", Buffer.alloc(5 * 1024 * 1024 + 1), "image/png")).status, 413);
  const uploaded = await upload(adminCookie, "QR", fixture);
  assert.equal(uploaded.status, 201);
  const qr = await uploaded.json() as { id: string; url: string };
  assert.equal((await fetch(`${base}${qr.url.slice(4)}`, { headers: { Cookie: otherCookie } })).status, 404);
  const qrResponse = await fetch(`${base}${qr.url.slice(4)}`, { headers: { Cookie: adminCookie } });
  assert.equal(qrResponse.status, 200);
  assert.match(qrResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(qrResponse.headers.get("content-type"), "image/png");
  assert.equal((await sanitizeImage(fixture, "image/jpeg")).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await assert.rejects(sanitizeImage(fixture, "image/png"), errorStatus(400));
  const receipt = await storePrivateImage(ownerId, "RECEIPT", fixture, "image/jpeg");
  assert.equal((await fetch(`${base}/deposits/images/${receipt.id}`)).status, 401);
  assert.equal((await fetch(`${base}/deposits/images/${receipt.id}`, { headers: { Cookie: otherCookie } })).status, 404);
  assert.equal((await fetch(`${base}/deposits/images/${receipt.id}`, { headers: { Cookie: ownerCookie } })).status, 200);
  assert.equal((await fetch(`${base}/deposits/images/${receipt.id}`, { headers: { Cookie: adminCookie } })).status, 200);
  const settingsInput = {
    accountName: original.accountName, accountNumber: original.accountNumber,
    instructions: original.instructions, minimumAmount: original.minimumAmount.toFixed(2),
    qrImageId: original.qrImageId, submissionsEnabled: false, expectedVersion: original.version,
  };
  assert.equal((await fetch(`${base}/admin/deposits/settings`, {
    method: "PUT", headers: { Cookie: ownerCookie, "Content-Type": "application/json", "X-WealthNova-Request": "1" },
    body: JSON.stringify(settingsInput),
  })).status, 403);
  assert.equal((await fetch(`${base}/admin/deposits/settings`, {
    method: "PUT", headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify(settingsInput),
  })).status, 403);
  assert.equal((await fetch(`${base}/admin/deposits/settings`, {
    method: "PUT", headers: { Cookie: adminCookie, "Content-Type": "application/json", "X-WealthNova-Request": "1" },
    body: JSON.stringify({ ...settingsInput, expectedVersion: original.version + 99 }),
  })).status, 409);
  // Success-path accounting tests use UNCOMMITTED settings fixtures. No live
  // settings, requests, account details, ledger, or wallet funds are changed.
  try {
    await prisma.$transaction(async tx => {
      await tx.depositPaymentSettings.update({
        where: { id: "gcash" },
        data: {
          qrImageId: qr.id, accountName: "UNCOMMITTED TEST ONLY",
          accountNumber: "+639000000000", instructions: "TEST ONLY DO NOT PAY",
          minimumAmount: "100.00", submissionsEnabled: true,
        },
      });
      const testDatabase = {
        depositRequest: tx.depositRequest,
        $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
      };
      const input = {
        amount: "100.00", transactionReference: "TEST-REF-123456",
        receiptImageId: receipt.id, idempotencyKey: randomUUID(), settingsVersion: original.version,
      };
      await assert.rejects(submitDeposit(ownerId, { ...input, amount: "99.99" }, testDatabase), errorStatus(400));
      await assert.rejects(submitDeposit(otherId, input, testDatabase), errorStatus(400));
      await assert.rejects(submitDeposit(ownerId, { ...input, amount: "0" }, testDatabase), errorStatus(400));
      const first = await submitDeposit(ownerId, input, testDatabase);
      assert.equal(first.record.status, "PENDING_VERIFICATION");
      assert.equal(first.record.transactionReference, "TESTREF123456");
      assert.equal(first.record.amount.toFixed(2), "100.00");
      const replay = await submitDeposit(ownerId, input, testDatabase);
      assert.equal(replay.record.id, first.record.id);
      assert.equal(replay.replayed, true);
      await assert.rejects(submitDeposit(ownerId, { ...input, amount: "200.00" }, testDatabase), errorStatus(409));
      assert.equal(await tx.depositRequest.count({ where: { userId: ownerId } }), 1);
      assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: ownerId } })).availableBalance.toFixed(2), "0.00");
      assert.equal(await tx.ledgerEntry.count({ where: { userId: ownerId } }), 0);
      // All financial approvals below remain inside this rollback transaction.
      const approve = { type: "APPROVE" as const, data: approvalInput };
      await assert.rejects(decideDeposit(ownerId, first.record.id, approve, testDatabase), errorStatus(403));
      await assert.rejects(decideDeposit(adminId, first.record.id, {
        type: "APPROVE", data: { ...approvalInput, confirmedPaymentReceived: false },
      }, testDatabase), errorStatus(400));
      await assert.rejects(decideDeposit(adminId, first.record.id, {
        type: "APPROVE", data: { ...approvalInput, verifiedAmount: "101.00" },
      }, testDatabase), errorStatus(400));
      await tx.user.update({ where: { id: ownerId }, data: { role: "ADMIN" } });
      await assert.rejects(decideDeposit(ownerId, first.record.id, approve, testDatabase), errorStatus(403));
      await tx.user.update({ where: { id: ownerId }, data: { role: "USER" } });
      const approved = await decideDeposit(adminId, first.record.id, approve, testDatabase);
      assert.equal(approved.deposit.status, "APPROVED");
      assert.equal(approved.deposit.reviewedById, adminId);
      assert.ok(approved.deposit.approvedAt);
      assert.equal(approved.deposit.verifiedAmount?.toFixed(2), "100.00");
      assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: ownerId } })).availableBalance.toFixed(2), "100.00");
      const ledger = await tx.ledgerEntry.findUniqueOrThrow({ where: { depositRequestId: first.record.id } });
      assert.equal(ledger.type, "DEPOSIT_CREDIT");
      assert.equal(ledger.amount.toFixed(2), "100.00");
      assert.equal(ledger.balanceAfter.toFixed(2), "100.00");
      assert.equal((await tx.depositDecisionAudit.findUniqueOrThrow({ where: { depositId: first.record.id } })).adminId, adminId);
      assert.equal((await decideDeposit(adminId, first.record.id, approve, testDatabase)).alreadyProcessed, true);
      assert.equal(await tx.ledgerEntry.count({ where: { depositRequestId: first.record.id } }), 1);
      assert.equal(await tx.depositDecisionAudit.count({ where: { depositId: first.record.id } }), 1);
      await assert.rejects(decideDeposit(adminId, first.record.id, {
        type: "REJECT", data: { reason: "Cannot overwrite an approval" },
      }, testDatabase), errorStatus(409));
      const makePending = async () => {
        const image = await tx.depositImage.create({
          data: {
            userId: ownerId, purpose: "RECEIPT", objectPath: `/uncommitted-test/${randomUUID()}`,
            contentType: "image/png", size: receipt.size, digest: randomUUID(),
          },
        });
        return submitDeposit(ownerId, {
          ...input, idempotencyKey: randomUUID(), receiptImageId: image.id,
          transactionReference: `TEST${randomUUID().replaceAll("-", "")}`,
        }, testDatabase);
      };
      const toReject = await makePending();
      const rejection = { type: "REJECT" as const, data: { reason: "Unverified test receipt — no payment was received." } };
      await assert.rejects(decideDeposit(adminId, toReject.record.id, {
        type: "REJECT", data: { reason: "   " },
      }, testDatabase), errorStatus(400));
      const rejected = await decideDeposit(adminId, toReject.record.id, rejection, testDatabase);
      assert.equal(rejected.deposit.status, "REJECTED");
      assert.equal(rejected.deposit.rejectionReason, rejection.data.reason);
      assert.equal(rejected.deposit.approvedAt, null);
      assert.equal(rejected.deposit.verifiedAmount, null);
      assert.equal(await tx.ledgerEntry.count({ where: { depositRequestId: toReject.record.id } }), 0);
      assert.equal((await decideDeposit(adminId, toReject.record.id, rejection, testDatabase)).alreadyProcessed, true);
      await assert.rejects(decideDeposit(adminId, toReject.record.id, approve, testDatabase), errorStatus(409));
      assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: ownerId } })).availableBalance.toFixed(2), "100.00");
      const differing = await makePending();
      const verifiedDifference = {
        type: "APPROVE" as const,
        data: { ...approvalInput, verifiedAmount: "95.00", confirmedAmountDifference: true },
      };
      const differenceResult = await decideDeposit(adminId, differing.record.id, verifiedDifference, testDatabase);
      assert.equal(differenceResult.deposit.amount.toFixed(2), "100.00");
      assert.equal(differenceResult.deposit.verifiedAmount?.toFixed(2), "95.00");
      assert.equal((await tx.ledgerEntry.findUniqueOrThrow({ where: { depositRequestId: differing.record.id } })).amount.toFixed(2), "95.00");
      assert.equal((await tx.depositDecisionAudit.findUniqueOrThrow({ where: { depositId: differing.record.id } })).amountDifferenceConfirmed, true);
      assert.equal((await decideDeposit(adminId, differing.record.id, verifiedDifference, testDatabase)).alreadyProcessed, true);
      await assert.rejects(decideDeposit(adminId, differing.record.id, {
        type: "APPROVE", data: { ...verifiedDifference.data, verifiedAmount: "94.00" },
      }, testDatabase), errorStatus(409));
      const racing = await makePending();
      const race = await Promise.allSettled([
        decideDeposit(adminId, racing.record.id, approve, testDatabase),
        decideDeposit(adminId, racing.record.id, approve, testDatabase),
      ]);
      assert.equal(race.filter(r => r.status === "fulfilled" && !r.value.alreadyProcessed).length, 1);
      assert.equal(await tx.ledgerEntry.count({ where: { depositRequestId: racing.record.id } }), 1);
      assert.equal(await tx.depositDecisionAudit.count({ where: { depositId: racing.record.id } }), 1);
      assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: ownerId } })).availableBalance.toFixed(2), "295.00");
      // Test the global unique reference constraint without leaving the outer
      // transaction in an aborted state after the deliberate constraint error.
      const unusedImage = await tx.depositImage.create({
        data: {
          userId: otherId, purpose: "RECEIPT", objectPath: `/uncommitted-test/${randomUUID()}`,
          contentType: "image/png", size: receipt.size, digest: randomUUID(),
        },
      });
      await tx.$executeRaw`SAVEPOINT duplicate_reference_test`;
      await assert.rejects(tx.depositRequest.create({
        data: {
          userId: otherId, amount: "100.00", transactionReference: first.record.transactionReference,
          receiptImageId: unusedImage.id, receiptDigest: unusedImage.digest, idempotencyKey: randomUUID(),
          accountName: "UNCOMMITTED TEST ONLY", accountNumber: "+639000000000", settingsVersion: original.version,
        },
      }), (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002");
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT duplicate_reference_test`;
      await tx.$executeRaw`RELEASE SAVEPOINT duplicate_reference_test`;
      throw rollback;
    }, { timeout: 30_000 });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(await prisma.depositRequest.count({ where: { userId: { in: users } } }), 0);
  assert.equal((await getPaymentSettings()).submissionsEnabled, false);
  assert.equal(await prisma.ledgerEntry.count({ where: { userId: { in: users } } }), 0);
  assert.equal(await prisma.depositDecisionAudit.count({ where: { adminId: { in: users } } }), 0);
  process.stdout.write("Deposit checks passed: submission, explicit verification, exact approval/ledger/audit, rejection without credit, duplicate and concurrent approval, unique references, self-approval and unauthorized access, private receipts and image validation. All financial test changes rolled back.\n");
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  const images = await prisma.depositImage.findMany({ where: { userId: { in: users } } });
  for (const image of images) await deletePrivateImage(image.objectPath);
  await prisma.depositRequest.deleteMany({ where: { userId: { in: users } } });
  await prisma.depositImage.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
