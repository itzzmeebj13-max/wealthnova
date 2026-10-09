---
name: Manual payment workflow reconciliation
description: Why independently developed deposit systems must not both remain active after a merge.
---

Keep one active deposit submission and approval system when merging parallel
financial implementations. Preserve the existing configured payment details,
receipt evidence, terminal decisions, and ledger links.

**Why:** Parallel branches evolved incompatible deposit contracts. Running
both systems would give each its own reference uniqueness boundary and could
accept or credit the same external payment twice.

**How to apply:** Integrate into the current member/Admin flow rather than
mounting a second router. Preserve old evidence without exposing a second
credit path. Refuse automatic conversion of nonempty legacy payment queues
until their receipts, decisions, and credits have been reconciled.

When integrating financial events after reconciliation, verify which retained
reference belongs to the active workflow; archived fields may still exist.

**Why:** A commission integration matched an archived deposit reference even
though the active verification had succeeded. This silently prevented eligible
commission generation until the actual credit relation was used.

**How to apply:** Follow the live approval writer and Prisma relations rather
than assuming a similarly named retained ledger field is current. Require the
active approval audit and active ledger credit together.
