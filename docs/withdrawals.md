# WealthNova manual GCash withdrawals

## Member access

Open **Account → Withdraw to GCash**. The five bottom navigation items remain unchanged.

Only the wallet's available verified balance can fund a request. Pending deposits, displayed plan daily figures, invested principal, and already reserved funds are not spendable withdrawal funds.

Enter a positive PHP amount with up to two decimal places, the actual GCash receiving name, and a Philippine mobile number. The server normalizes the number and calculates the 5% fee, rounded half-up to the nearest cent. For ₱1,000, the fee is ₱50 and the net payout is ₱950.

The full requested amount—not just the net payout—is reserved. A member can have one Pending or Processing withdrawal at a time. The client retains the same request key and details for safe retries; a retry does not create another reservation.

History shows the amount, fee, net, recipient, submission date, status, payout reference and rejection reason. Review updates are stored as in-app notifications; no email or SMS is sent.

## Authorized Admin workflow

Open **Account → Review withdrawals**.

1. Check the member, recipient and server-calculated amounts.
2. **Start processing** claims the review for the signed-in Admin. This is not a bank transfer or confirmation that money was sent.
3. The assigned Admin independently handles the actual GCash payout outside WealthNova.
4. Only after verifying the real transfer, enter its actual transaction reference, exact net paid amount, and verification note. Check the payout confirmation and record completion.
5. If no payout was sent, reject with a reason and the no-payout confirmation instead. The full reserved amount is released once, including the uncharged prospective fee.

Pending requests can also be rejected without starting Processing. Only the assigned processor can complete or reject a Processing request. Administrators cannot review their own withdrawals; another authorized Admin is required.

**Do not resend a payout after a network error.** Reconcile the GCash transaction and retry recording the same reference. Conflicting or reused references are rejected. The app cannot prevent an operator from manually sending money twice outside it.

A stalled Processing request must not be blindly reassigned or refunded. Its processor must reconcile whether an external payment occurred first. There is no automatic payout, automatic timeout refund, or implicit reassignment.

## Accounting and security

All monetary calculations and changes are performed in serializable database transactions. Requests, conditional wallet changes, unique ledger references, audits and notifications commit together.

The wallet separates available and reserved balances. Existing ledger entries remain in the `AVAILABLE` bucket:

| Event | Available bucket | Reserved bucket |
| --- | --- | --- |
| Request | −gross amount | +gross amount |
| Completed | No second deduction | −net payout and −fee |
| Rejected | +gross amount | −gross amount |

Ledger `balanceAfter` refers to its recorded bucket. Admin decisions are append-only audit records. Final statuses cannot be changed through the API. User history and notification acknowledgements are owner-scoped; Admin permissions are enforced server-side and rechecked inside financial transactions.

## Verification command

Run `pnpm --filter @workspace/api-server run test:withdrawals`.

The test creates disposable zero-balance accounts and sessions. Its synthetic funding, requests, payouts, ledger entries and decisions exist only inside a rollback-only PostgreSQL transaction, with operation-level savepoints. It makes no actual GCash transfer and does not change real payment settings or balances. Temporary accounts are removed afterward.
