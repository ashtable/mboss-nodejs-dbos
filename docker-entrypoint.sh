#!/bin/sh
# The worker owns no schema of its own — DBOS creates its system tables at launch — so there is
# no migration to run before the process starts.
set -e
# The local binary, not `npx`: tsx is what the
# process runs on, so a start command that could
# reach for the registry instead is a trap.
exec ./node_modules/.bin/tsx src/main.ts
