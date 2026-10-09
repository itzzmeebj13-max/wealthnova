# Manual GCash implementation and merge report

## Final implementation

There is one active manual deposit workflow, integrated with the newer main
branch's existing member/Admin screens and database models. It retains
configured GCash details, receipt hashes, request retry keys, versioned
settings, independent payment verification, and withdrawal functionality.
The competing deposit router/UI were retired rather than enabling two
reference/credit systems.

Members submit amount, transaction reference and a private receipt. Requests
remain Pending Verification. Only an active authorized Administrator, after
independently confirming money received, can approve the exact verified amount.
Approval atomically updates the wallet, ledger and decision audit. Rejection
requires a reason and credits nothing. Duplicate references, receipt hashes,
conflicting decisions, duplicate credits and self-approval are blocked.

No gateway, automatic GCash verification, seeded shared funds, password
recovery, SMS OTP, regulatory claim or guaranteed-return claim was added.

## Files changed or retained in the merged flow

- `artifacts/wealthnova/src/App.tsx`: dedicated Admin payment-settings route
  and role-specific payment/review navigation; existing withdrawals preserved.
- `artifacts/wealthnova/src/components/deposit-content.tsx`: reusable
  Admin-only payment settings page; existing member/upload/history/settings
  behavior retained, including requested disabled-button presentation.
- Existing `components/admin-deposit-dashboard.tsx`, deposit/withdrawal styles,
  routes and helpers retained rather than replaced.
- `artifacts/api-server/src/routes/member.ts`: availability response no-store.
- Existing `routes/deposits.ts`, `lib/deposits.ts`,
  `lib/deposit-settings.ts`, `lib/deposit-decisions.ts`, `lib/private-images.ts`
  remain the active deposit implementation. Images are validated from actual
  bytes and sanitized into private server-written objects, not writable
  permanent browser upload destinations.
- `artifacts/api-server/src/lib/manual-deposits.test.ts`: disposable-schema
  wrapper for the active suite plus true committed concurrency, replay,
  rejection, decimal-credit and forced-rollback checks.
- `artifacts/api-server/package.json`: isolated financial validation command
  and test dependencies; withdrawal/QR tooling retained.
- `lib/db/prisma/schema.prisma`: combined model set and retained audit archive.
- `lib/db/prisma/baseline-existing.mjs`: guarded development-workspace
  baseline adoption for the known pre-migration schemas.
- `lib/db/prisma/migrations/`: five migrations listed below and lock metadata.
- `lib/api-spec/openapi.yaml`: newer deposit/withdrawal API contract retained.
- `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/`:
  regenerated from that contract, not hand-merged.
- `scripts/src/grant-admin.ts`, `scripts/package.json`: trusted operator
  assignment of Admin to a chosen existing active account.
- `scripts/post-merge.sh`, `.replit`, `pnpm-lock.yaml`: safe setup, validation
  configuration and regenerated dependency resolution.
- `replit.md`, both manual-GCash documentation files, and project memory:
  operating instructions and durable reconciliation/evidence lessons.

## Migrations

1. `202610090001_baseline`: original pre-deposit schema.
2. `202610090002_manual_gcash`: first disabled implementation.
3. `202610090003_deposit_constraints`: its durable financial checks.
4. `202610090004_unify_manual_deposits`: additive reconciliation with the
   newer deposit and withdrawal schema. Retains earlier files/settings and
   ledger relations as audit archives; does not overwrite current configured
   payment details or financial records. Refuses to automatically archive
   a nonempty legacy payment queue.
5. `202610090005_preserve_referral_schema`: preserves the newer incoming
   referral/company-fund schema in additive migration history; existing balances
   and rate snapshots are not overwritten. The existing referral installer and
   API regeneration remain in post-merge setup.

All are applied in this development workspace. A newer branch which previously
used `db:push` adopts the historical baseline after guarded checks, then applies
the fourth reconciliation migration. No reset, production migration or
production deployment was performed.

## Verification

- Full workspace TypeScript checks passed after API/Prisma regeneration.
- `test:deposits` now exercises the active merged flow in a disposable schema:
  real private uploads, invalid files, ownership/Admin gates, settings
  enablement/version checks, pending submission, unique references/receipts,
  approval/rejection, self-approval protection and decision audits.
- **20 additional isolated checks** passed: forced ledger failure rolls back
  request, wallet and audit; simultaneous approval commits one credit; replay
  preserves that credit; rejection/replay credits nothing; distinct concurrent
  decimal approvals preserve the exact aggregate.
- Development post-merge installation, Prisma generation and migration
  deployment passed.
- Separate incoming-branch baseline test passed: an existing pending request,
  receipt, configured account details/settings version, and zero wallet were
  unchanged after baseline adoption and reconciliation. Database/schema diff
  reported no difference.
- The earlier branch passed 96 assertions and focused browser upload/access/
  disabled-setting checks before reconciliation. That historical result is not
  presented as a new browser test of the merged multipart contract.

All test bookkeeping uses disposable fixtures, not real payments or existing
members' balances. Receipts alone never establish that money was received.

## Setup remaining

Select an authorized existing active Admin account, configure actual GCash
QR/name/number/instructions and minimum amount, confirm the details, then
explicitly enable submissions. Existing saved settings on the newer main
branch are preserved. Never approve until the actual payment is independently
confirmed. See `manual-gcash-setup.md`.
