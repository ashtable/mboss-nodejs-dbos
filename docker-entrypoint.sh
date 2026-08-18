#!/bin/sh
# The worker owns no schema of its own — DBOS creates its system tables at launch — so there is
# no migration to run before the process starts.
set -e
exec npx tsx src/main.ts
