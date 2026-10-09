---
name: Immutable deposit evidence
description: Why direct-upload URLs must never target finalized payment evidence
---

Finalize private payment evidence by decoding and storing a sanitized copy at
a new, non-writable location. Do not make a browser-supplied upload path the
permanent receipt.

**Why:** A signed PUT URL remains writable until its expiry, even after the
first upload has been validated. Reusing that object as permanent evidence
would let the uploader replace the receipt after an Admin reviewed it.

**How to apply:** Keep temporary upload destinations separate from finalized
evidence when modifying uploads or adding new financial document workflows.
