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
- `pnpm --filter @workspace/db run db:seed` — ensure the disabled bootstrap inviter exists
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
- Deposit actions remain unavailable until a real payment provider is configured; no payment result is simulated.

## Product

- Member pages: Home, Plans, Deposit, Invite, and Account. Registration and login are separate routes.
- No configured plans are seeded; the Plans page uses a real empty state until plans are supplied.

## User preferences

- Keep registration mobile-only with required password and referral code; do not add email authentication, email verification, KYC, or an Activity tab.
- Do not show fake payment confirmations or make regulatory claims.

## Gotchas

- After changing `lib/db/prisma/schema.prisma`, run Prisma client generation before typechecking the API and synchronize only the development schema with `db:push`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
