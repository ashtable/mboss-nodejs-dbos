import { DBOS } from '@dbos-inc/dbos-sdk';

import { buildDeps } from './deps.js';
import { readEnv } from './env.js';
import { startWorker } from './worker.js';

/**
 * The boot script. Everything that can fail —
 * a missing token, an unreachable database —
 * fails here, before the worker has accepted any
 * work, rather than one workflow at a time
 * afterwards.
 */
const env = readEnv(process.env);

// The container runtime stops the worker with
// SIGTERM. Shutting DBOS down closes the system
// database pool and lets the queue's in-flight
// workflow finish its current step, so the next
// process resumes from a clean checkpoint rather
// than from a severed connection.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void DBOS.shutdown().then(() => process.exit(0));
  });
}

await startWorker(buildDeps(env), {
  name: 'mboss-dbos',
  systemDatabaseUrl: env.DBOS_SYSTEM_DATABASE_URL,
});
