---
name: Deposit availability display
description: User-requested presentation of the unavailable state on the member Deposit page.
---

Do not reintroduce the unavailable-deposit warning blocks above the QR or in the submission form. Show availability through the disabled submit button instead.

**Why:** The user asked to remove the QR-area warning, then also asked to remove the long warning moved into the submission form. They explicitly required warning removal not to enable deposits.

**How to apply:** Preserve frontend and backend submission gates, the actual QR, and saved payment settings when changing this display. This does not remove field-validation errors or Admin payment-verification safeguards.
