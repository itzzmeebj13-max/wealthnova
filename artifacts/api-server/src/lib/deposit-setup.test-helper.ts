import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import type { DepositPaymentSettings, Prisma, PrismaClient } from "@prisma/client";
import { GetDepositPaymentSettingsResponse, UploadDepositImageResponse, SubmitDepositRequestResponse } from "@workspace/api-zod";
import { createDepositRouter } from "../routes/deposits";

/** Real authenticated HTTP handlers and PostgreSQL, scoped to a rollback-only
 * transaction. Synthetic receiving details are never visible to the live app. */
export async function checkDepositSetupFlow(
  tx: Prisma.TransactionClient,
  original: DepositPaymentSettings,
  ownerId: string,
  ownerCookie: string,
  adminCookie: string,
  qrImageId: string,
  receiptImageId: string,
  fixture: Buffer,
) {
  const scopedDatabase = {
    depositImage: tx.depositImage, depositPaymentSettings: tx.depositPaymentSettings,
    depositRequest: tx.depositRequest, depositDecisionAudit: tx.depositDecisionAudit,
    $transaction: async (input: ((client: typeof tx) => Promise<unknown>) | Promise<unknown>[]) =>
      typeof input === "function" ? input(tx) : Promise.all(input),
  } as unknown as PrismaClient;
  const app = express();
  app.use(express.json(), cookieParser(), pinoHttp({
    autoLogging: false,
    serializers: { req: r => ({ method: r.method, url: r.url?.split("?")[0] }), res: r => ({ statusCode: r.statusCode }) },
  }));
  app.use("/api", createDepositRouter(scopedDatabase));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Isolated test server unavailable.");
  const base = `http://127.0.0.1:${address.port}/api`;
  const send = (path: string, cookie: string, body: unknown, method = "POST") => fetch(base + path, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json", "X-WealthNova-Request": "1" },
    body: JSON.stringify(body),
  });
  const setup = {
    accountName: "UNCOMMITTED TEST ONLY", accountNumber: "09000000000",
    instructions: "TEST ONLY DO NOT PAY", minimumAmount: "350.00",
    qrImageId, submissionsEnabled: true, accountDetailsConfirmed: true, expectedVersion: original.version,
  };
  const input = {
    amount: "350.00", transactionReference: "TEST-REF-123456", receiptImageId,
    idempotencyKey: randomUUID(), settingsVersion: original.version,
  };
  try {
    assert.equal((await send("/deposits/requests", ownerCookie, input)).status, 409, "Disabled deposits must reject valid requests");
    assert.equal((await send("/admin/deposits/settings", ownerCookie, setup, "PUT")).status, 403);
    assert.equal((await send("/admin/deposits/settings", "", setup, "PUT")).status, 401);
    for (const missing of [{ accountName: "" }, { accountNumber: "" }, { instructions: "" }, { qrImageId: null }]) {
      assert.equal((await send("/admin/deposits/settings", adminCookie, { ...setup, ...missing }, "PUT")).status, 400);
    }
    assert.equal((await send("/admin/deposits/settings", adminCookie, { ...setup, accountDetailsConfirmed: false }, "PUT")).status, 400);
    assert.equal((await send("/admin/deposits/settings", adminCookie, { ...setup, minimumAmount: "349.99" }, "PUT")).status, 400);
    const disabled = await send("/admin/deposits/settings", adminCookie, { ...setup, submissionsEnabled: false }, "PUT");
    assert.equal(disabled.status, 200);
    const disabledSettings = GetDepositPaymentSettingsResponse.parse(await disabled.json());
    assert.equal(disabledSettings.enabled, false);
    assert.equal(disabledSettings.configured, true);
    assert.equal((await send("/deposits/requests", ownerCookie, { ...input, settingsVersion: disabledSettings.version })).status, 409);
    const enabled = await send("/admin/deposits/settings", adminCookie, { ...setup, expectedVersion: disabledSettings.version }, "PUT");
    assert.equal(enabled.status, 200);
    const enabledSettings = GetDepositPaymentSettingsResponse.parse(await enabled.json());
    assert.equal(enabledSettings.enabled, true);
    assert.equal(enabledSettings.accountDetailsConfirmed, true);
    assert.equal(enabledSettings.accountNumber, "+639000000000");
    assert.equal(enabledSettings.minimumAmount, "350.00");
    assert.deepEqual(enabledSettings.blockingReasons, []);
    input.settingsVersion = enabledSettings.version;
    const memberSettings = await fetch(base + "/deposits/settings", { headers: { Cookie: ownerCookie } });
    assert.equal(GetDepositPaymentSettingsResponse.parse(await memberSettings.json()).enabled, true, "Members and Admin must use the same saved setting");
    const form = new FormData();
    form.set("purpose", "RECEIPT");
    form.set("file", new Blob([new Uint8Array(fixture)], { type: "image/jpeg" }), "isolated-test-receipt.jpg");
    const uploaded = await fetch(base + "/deposits/images", {
      method: "POST", headers: { Cookie: ownerCookie, "X-WealthNova-Request": "1" }, body: form,
    });
    assert.equal(uploaded.status, 201, "Enabled deposit flow must accept a valid private receipt upload");
    input.receiptImageId = UploadDepositImageResponse.parse(await uploaded.json()).id;
    assert.equal((await send("/deposits/requests", ownerCookie, { ...input, amount: "349.99" })).status, 400);
    const { transactionReference: _ref, receiptImageId: _receipt, ...missingFields } = input;
    assert.equal((await send("/deposits/requests", ownerCookie, { ...missingFields, receiptImageId: input.receiptImageId })).status, 400);
    assert.equal((await send("/deposits/requests", ownerCookie, { ...missingFields, transactionReference: input.transactionReference })).status, 400);
    assert.equal((await send("/deposits/requests", "", input)).status, 401);
    const created = await send("/deposits/requests", ownerCookie, input);
    assert.equal(created.status, 201);
    assert.equal(SubmitDepositRequestResponse.parse(await created.json()).status, "PENDING_VERIFICATION");
    assert.equal((await tx.wallet.findUniqueOrThrow({ where: { userId: ownerId } })).availableBalance.toFixed(2), "0.00");
    assert.equal(await tx.ledgerEntry.count({ where: { userId: ownerId } }), 0);
    assert.equal((await send("/deposits/requests", ownerCookie, input)).status, 200);
    assert.equal(await tx.depositRequest.count({ where: { userId: ownerId } }), 1);
    return input;
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
