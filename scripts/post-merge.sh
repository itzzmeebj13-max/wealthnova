#!/bin/bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run prisma:generate
pnpm --filter @workspace/db run db:push
pnpm --filter @workspace/db run referrals:install
pnpm --filter @workspace/api-spec run codegen
