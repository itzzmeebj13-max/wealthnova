---
name: Conflict-time tooling
description: Why .replit conflicts should be resolved before invoking workspace tools
---

Resolve invalid `.replit` TOML before attempting package or runtime repairs.

**Why:** During a rebase conflict, the development shell lost its Nix-provided
PATH: both pnpm and ripgrep disappeared despite already being installed.
Validating and replacing the merged `.replit` restored those commands.

**How to apply:** Preserve incoming structural configuration and task workflow
entries, write a temporary merged TOML, and use the platform's validated
replacement operation. Do not install duplicate runtimes to work around
an invalid configuration.
