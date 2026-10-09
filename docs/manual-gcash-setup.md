# Manual GCash setup and operation

## Admin access

Select an existing active account belonging to the authorized Administrator:

```sh
pnpm --filter @workspace/scripts grant-admin <existing-mobile-number> --confirm-admin-access
```

This trusted workspace-only command changes the selected account's role. It
does not create accounts/passwords or grant funds. Do not promote arbitrary
members. There is no public role-edit endpoint or default Admin password.

## Payment configuration

1. Sign in as the authorized Admin and open **Payments**
   (`/admin/payment-settings`). Settings are also available on Deposit for
   Administrators.
2. Upload the owner's actual GCash QR (PNG/JPEG/WebP, at most 5 MB).
3. Enter the actual account name, Philippine GCash number, instructions, and
   minimum deposit amount. Never use sample receiving details.
4. Independently check the QR and receiving account, then acknowledge the
   account-details confirmation. Changing details invalidates that confirmation.
5. Explicitly enable submissions and save. Complete/confirmed details are
   required; saving an image preview alone does not update live settings.
6. Review requests at `/admin/deposits`. Approve only after independently
   checking money received in the actual GCash account. Enter the exact
   verified amount and a meaningful verification note; explicitly acknowledge
   any difference from the claimed amount. Self-approval is prohibited.
7. Reject with a reason if payment cannot be confirmed. Final decisions cannot
   be reversed or credited twice. Disabling new requests does not erase old
   requests or prevent their review.

No QR means real payment details are unavailable; no replacement details are
invented. Member submissions remain blocked until explicitly enabled. The
member unavailable state uses the disabled submit button, preserving the
requested removal of redundant warning blocks.

## Privacy and validation

Receipts and QR images use private App Storage. Uploads are actual-byte
validated, fully decoded and re-encoded to remove metadata/appended payloads.
The active flow uploads through the authenticated backend; browsers do not
receive write access to finalized evidence. Receipts are readable only by
their owner or an authorized Admin. Configured QR visibility is authenticated.
Do not publish object paths or personal receiving details outside the intended
authenticated payment flow.

Requests retain account details/settings version used at submission. Receipt
hashes and transaction references prevent duplicates; retry keys identify an
existing member request. Only audited Admin approval changes wallet funds.

## Development migration history

Run `bash scripts/post-merge.sh` in the trusted development workspace. It
installs the lockfile, generates Prisma, adopts an already-existing baseline
where recognized, then deploys additive migrations without a reset.

- Empty databases apply all five migrations normally.
- Original pre-deposit databases mark the original baseline applied, then
  apply the additive migrations.
- The recognized newer manual-deposit/withdrawal schema previously created
  with `db:push` records the first three historical steps as baseline, then
  applies the reconciliation migration. Current data/settings are not copied,
  replaced, seeded or reset.
- The first disabled implementation's tables/evidence remain audit archives.
  A nonempty legacy payment queue blocks automatic reconciliation; inspect and
  explicitly reconcile its evidence, decisions and ledger before proceeding.
- Failed/unknown schema states require inspection, not `migrate reset`.
- The existing referral installer/API regeneration are retained after migration
  deployment. The fifth additive migration preserves incoming referral schema
  without changing its business rules or funding member balances.

This setup helper is for development workspace merges, not a production
startup hook. For Replit-managed production, use the supported Publish schema
review; do not run these development baseline operations against production.
No production deployment was performed here.

## Validation

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server run test:deposits
```

The financial suite uses a disposable database schema and temporary uploads,
not existing balances, configured payment details or real GCash payments.
