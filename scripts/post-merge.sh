#!/bin/bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run prisma:generate
pnpm --filter @workspace/db exec node prisma/baseline-existing.mjs
pnpm --filter @workspace/db exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @workspace/db run referrals:install
pnpm --filter @workspace/api-spec run codegen
