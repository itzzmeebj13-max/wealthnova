# Referral management and funded wallet commissions

## Verified-deposit policy verification

The financial suite verifies fixed 20%/3%/1% on actual verified PHP 350 (even for
a PHP 500 request): PHP 70/10.50/3.50 once. It covers Pending requests,
replays, no old-deposit backfill, no new investment awards, preserved historical
20% snapshots, actual qualification, funded earnings and source eligibility.

The browser pass verified personal-link registration, distinct codes and saved
parent relationship, current rates, totals, copy/share fallback, real
registration notification and Invite layouts at 320/390. It was manually skipped
before Admin-dialog focus/bounds regression checks. A scoped wrapping fix was
applied to the reported Admin overflow but was not rechecked in that skipped
pass. Temporary accounts, temporary Admin access, sessions, zero wallets and test
notification were removed afterwards. No live financial decision was made.

## Member experience

The existing Invite page now shows the referral code/link, copy controls, direct
and three-tier counts, copy/share controls, qualified referrals, actually paid earnings, current rates, status totals, own commission history and
event-based notifications. History filters are All, Pending, Approved, Rejected
and Paid. “Paid” means an authorized **wallet credit**, not a GCash payout.

Network totals cover the three supported tiers. Member history masks referred
mobile numbers and is always scoped to the signed-in beneficiary. An arbitrary
beneficiary/user query parameter never changes that scope.

## Admin experience

Account → Referral management opens `/admin/referrals`. Active Admin permission
is enforced by the API, with a fresh role check in financial/rate transactions.

- Active deposit rates are fixed at 20%, 3%, 1%. Both the API and the database
  reject new deposit-rate versions with different percentages. Admins may record
  a policy confirmation with a reason and current version, preventing stale
  concurrent confirmations. Historical rate versions remain intact.
- Rate history is append-only and records the Admin, timestamp and reason.
  Existing commissions retain their rate, basis, amount and source reference.
- The queue supports status filters, pagination and search by commission ID,
  account number or source ledger reference.
- Pending commissions can be approved or rejected. Approval reserves fully
  verified operating funds; it does **not** create spendable wallet money.
- Approved commissions can be paid to the wallet or rejected. Payment transfers
  reserved funds and creates a unique financial ledger credit. Rejection releases
  the reservation exactly once. Final decisions cannot be reopened.
- Every decision creates an immutable decision record and one notification.

## Eligibility and event handling

No authentication, investment-plan, deposit or withdrawal application code was
changed. Referral event handlers live in PostgreSQL, installed separately from
the Prisma schema:

- Successful member insertion notifies the original active inviter.
- Deposit approval generates at most three Pending snapshots **inside the
  existing verification transaction**, only once both approval audit and the
  active deposit's wallet-credit ledger exist. Calculations use verified amount,
  not the member's requested amount.
- The append-only policy activation timestamp determines the cutover. Past
  approved deposits are never backfilled; new investment purchases generate no
  additional commissions. Existing investment-source commissions remain intact.
- The bootstrap invite-only account does not receive commissions.
- The rate version effective at the server-recorded purchase start time is used.
  The default baseline applies to prior verified purchases without snapshots;
  installation reconciles those purchases idempotently.
- Inactive beneficiaries are excluded from generation. Approval and payment
  revalidate source eligibility and beneficiary status; cancelled investments
  cannot be approved or paid. Admins can reject invalidated unpaid commissions.
- Original referrers and historical commission snapshots are database-protected.

Verification and commission-recorded notifications are inserted with the actual
source event. Approval, rejection and paid notifications commit with their
respective decisions. Unique event keys prevent repeats. Notification reads are
owner-only.

## Real funding only

The operating reserve starts at **PHP 0**, separate from member principal.

1. **Verified retained withdrawal fees:** the referral module reads existing
   Completed withdrawals with actual payout reference, completion audit, matching
   payout/fee ledger entries and reconciled gross/net amounts. It records the fee
   once. Pending/Processing/Rejected withdrawals never fund the reserve.
2. **Separately verified company capital:** an active Admin uploads a private
   JPEG/PNG/WebP receipt (maximum 5 MB), records actual amount/reference and an
   independent verification note, and explicitly confirms real company money
   was received. A unique request key protects uncertain retries.

Manual bank verification remains the administrator’s responsibility. The app
does not confirm payments with GCash or claim a payment happened automatically.

A shared database evidence claim prevents any incoming reference or receipt
digest from funding both a member deposit and company capital, including future
attempts to reuse capital evidence as a deposit. Existing deposit records are
preserved and their evidence is reserved. No QR, receiving account, minimum,
deposit setting or deposit approval logic was changed.

Private capital receipts reuse the existing protected image reader. Evidence
retention must include company-capital images and their bank-reference claims;
they are not abandoned uploads.

## Setup and verification

After applying the additive schema:

```sh
pnpm --filter @workspace/db run prisma:generate
pnpm --filter @workspace/db exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @workspace/db run referrals:install
pnpm --filter @workspace/api-spec run codegen
```

The post-merge setup includes these steps. The installer is idempotent and never
seeds balances, overwrites saved rates or changes existing member funds. A fresh
deployment/database must apply both the Prisma schema and referral event
installer before accepting investment purchases.

Verification commands:

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server run test:referrals
```

The API suite exercises real HTTP sessions/permissions and PostgreSQL. Synthetic
financial balances, source transactions, receipts, external-payment attestations,
rate changes and wallet credits run within a rollback-only transaction with
operation savepoints. Disposable sessions, notifications, zero-balance wallets
and users are removed. No real payments are sent or fake cash committed.

### Additional financial regression coverage

The suite explicitly tests an Approved commission with an insufficient reserved
balance: payment returns 409, the commission stays Approved, and no wallet
credit, Paid audit or Paid notification is created. The simulated shortage is
itself rolled back before normal completion is tested.

Separate funding totals are verified with rollback-only fixtures: company
capital PHP 1,000, actually completed-payout fees PHP 50 and funded wallet payments
PHP 70 reconcile to PHP 980 available and zero reserved. Both source types retain
distinct financial entries. These values are test fixtures, not live money.

### Invite and Admin review controls

Invite shows a server-calculated total across all commission statuses, with
separate Pending/Approved/Rejected/Paid amounts. The total explicitly includes
rejected records and is not a spendable balance. Saved rates, history and unread
notifications refresh every 15 seconds while the page is open.

Admin review appears first in Referral Management. Pending records show Approve
and Reject at the top of the record; Approved records show Pay to wallet and
Reject, while final records offer only audit history. Each financial action
opens an accessible confirmation dialog with an unchecked confirmation and
required review note. If a refreshed status makes the action invalid, the dialog
closes. Server transaction, source verification, reserve checks and idempotency
remain authoritative.
