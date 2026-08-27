import { DBOS } from '@dbos-inc/dbos-sdk';

import type { WorkerDeps } from './deps.js';
import { registerWorkflows } from './workflows/register.js';

/**
 * Every cloud email send goes through this one
 * queue. One worker at a time is enough: a
 * broadcast iterates its recipients inside a
 * single workflow, so queue concurrency bounds
 * concurrent workflows rather than send
 * throughput.
 */
export const EMAIL_QUEUE = 'email';

/**
 * Bounce scans get their own queue because they
 * spend almost all of their life asleep. Uncapped,
 * on purpose: a scan waiting two days must never
 * hold the one slot every outgoing email shares.
 */
export const EMAIL_STATUS_QUEUE = 'email-status';

export type WorkerConfig = {
  name: string;
  systemDatabaseUrl: string;
};

/**
 * The order is load-bearing in both directions.
 * Registration has to finish before launch,
 * because launch is what publishes the registry.
 * The queue has to come after it, because a queue
 * is a row DBOS writes through the connection
 * launch opens — registering it first fails
 * outright, which
 * `test/integration/startup.integration.test.ts`
 * demonstrates.
 */
export async function startWorker(
  deps: WorkerDeps,
  config: WorkerConfig,
): Promise<void> {
  DBOS.setConfig(config);
  registerWorkflows(deps);
  await DBOS.launch();
  await DBOS.registerQueue(EMAIL_QUEUE, { workerConcurrency: 1 });
  await DBOS.registerQueue(EMAIL_STATUS_QUEUE);
}
