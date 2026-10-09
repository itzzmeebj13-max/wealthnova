# WealthNova

WealthNova is a mobile-first member finance portal with phone-based accounts, required referral onboarding, plans, deposit availability, invitations, and account details.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/wealthnova run dev` — run the WealthNova web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run prisma:generate` — generate the Prisma client
- `pnpm --filter @workspace/db run db:push` — sync the development PostgreSQL schema
- `pnpm --filter @workspace/db run db:seed` — ensure the disabled bootstrap inviter and seven investment plans exist
- Required env: `DATABASE_URL`, `SESSION_SECRET` (at least 32 characters)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Prisma 6
- Validation: OpenAPI-generated Zod schemas
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/wealthnova/src/` — responsive React member portal, routes, and theme
- `artifacts/api-server/src/routes/` — API endpoints
- `lib/db/prisma/schema.prisma` — PostgreSQL/Prisma schema
- `lib/api-spec/openapi.yaml` — API contract source of truth

## Architecture decisions

- Registration uses mobile number, password, and a valid referral code; no email or KYC flows are part of this product.
- Sessions are random, database-backed, HMAC-indexed HttpOnly cookies; passwords use Node's scrypt.
- The seeded `NOVA-START` inviter is a non-loginable system root used only to bootstrap referral registration.
- Manual GCash submissions default to disabled. Administrators must confirm the real QR, account name, Philippine account number, instructions, and minimum amount before enabling them after testing. No payment result is simulated.

## Product

- Member pages: Home, Plans, Deposit, Invite, and Account. Registration and login are separate routes.
- Seven configured investment plans are seeded with 25-day durations.
- Available balance is funded by verified deposits only. Manual GCash submissions stay pending and never credit wallets. An active ADMIN can approve only after independently confirming receipt of payment, entering the exact verified amount and a verification note. Do not seed member funds.
- Earnings and investment accumulated amounts represent verified credits only, not automatic daily accrual. The daily plan figures are informational and are not guaranteed returns.
- Starting investments uses server-owned plan amounts, decimal arithmetic, a serializable database transaction, conditional debit, and a per-member idempotency key.
- Payment settings are ADMIN-only. Receipts are private App Storage objects, accessible only to the uploading member or an authorized admin. Images are decoded and re-encoded; database records contain paths and metadata, not image bytes.
- Deposit requests enforce normalized unique transaction references, unique receipt hashes, and member-scoped idempotency keys. Concurrent payment-setting updates use a version check. New mutation routes require the `X-WealthNova-Request: 1` header.
- Deposit decisions are terminal and audited. Self-approval is forbidden. Approval atomically changes status, credits the server-validated verified amount once, records a unique deposit-linked ledger entry, and records the reviewer, timestamp, and audit. Rejection requires a reason and never credits the wallet.
- The submitted amount remains immutable. When the actual verified payment differs, an explicit Admin acknowledgment is required and audited, and only the verified amount is credited. This avoids requiring a resubmission with a permanently reserved transaction reference. A receipt alone is not proof of payment; there is no automated GCash verification.

## User preferences

- Keep registration mobile-only with required password and referral code; do not add email authentication, email verification, KYC, or an Activity tab.
- Do not show fake payment confirmations or make regulatory claims.

## Gotchas

- After changing `lib/db/prisma/schema.prisma`, run Prisma client generation before typechecking the API and synchronize only the development schema with `db:push`.
- `test:deposits` tests successful pending-request accounting with rolled-back, uncommitted settings; it must not enable public deposit submissions or seed wallet balances. Its disposable upload objects and accounts are cleaned up.
- Approval, rejection, duplicate/concurrent credit, and audit tests run inside a rolled-back transaction. Browser review tests may reject clearly labeled disposable pending fixtures, but must not fabricate a successful payment confirmation or approve test deposits in the shared app.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
