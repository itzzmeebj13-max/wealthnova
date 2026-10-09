---
name: Manual payout ownership
description: Why manual withdrawals restrict outstanding requests and bind payout decisions to their processor.
---

For manual GCash withdrawals, keep one Pending/Processing request per member and bind a Processing request's completion or rejection to its assigned Administrator. Do not silently reassign it or release its reservation.

**Why:** The app cannot make an external, manually sent GCash transfer idempotent. Different retry keys can duplicate a member's intent, and two administrators independently sending a payment can duplicate the real payout even when database completion is exactly once. These restrictions deliberately favor safety over parallel requests and unrestricted handoffs.

**How to apply:** Preserve this policy when extending withdrawal screens. A future reassignment flow must first reconcile whether a payout actually occurred, coordinate the handoff, and audit the change. Never assume a stalled Processing request is unpaid or automatically release/resend its funds.
