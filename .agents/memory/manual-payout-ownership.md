---
name: Manual payout ownership
description: Why manual withdrawals restrict outstanding requests and bind payout decisions to their processor.
---

For manual GCash withdrawals, keep one Pending/Processing request per member and bind a Processing request's completion or rejection to its assigned Administrator. Do not silently reassign it or release its reservation.

**Why:** The app cannot make an external, manually sent GCash transfer idempotent. Different retry keys can duplicate a member's intent, and two administrators independently sending a payment can duplicate the real payout even when database completion is exactly once. These restrictions deliberately favor safety over parallel requests and unrestricted handoffs.

**How to apply:** Preserve this policy when extending withdrawal screens. Reassignment must first reconcile whether a payout actually occurred, coordinate the handoff, and audit the change. Never assume a stalled Processing request is unpaid or automatically release/resend its funds.

Handoffs are accepted by the receiving Admin personally, not assigned to an absent third party. An unavailable processor does not establish payment status: reconciliation and stopping the previous processor's external payout access must be possible, otherwise leave the reservation held.

**Why:** Database ownership cannot revoke GCash access or stop a transfer already in flight. Personal acceptance and coordinated external access control are necessary even with conflict-safe database updates.

**How to apply:** Keep unknown or pending payments blocked; do not replace external coordination with timeout-based takeovers. An already-sent payment must retain its evidence and must never permit refund/rejection or a fresh transfer.
