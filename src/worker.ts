import { DBOS } from '@dbos-inc/dbos-sdk';

/**
 * Every cloud email send goes through this one
 * queue. One worker at a time is enough: a
 * broadcast iterates its recipients inside a
 * single workflow, so queue concurrency bounds
 * concurrent workflows rather than send
 * throughput.
 */
export const EMAIL_QUEUE = 'email';

export type WorkerConfig = {
  name: string;
  systemDatabaseUrl: string;
};

/**
 * Launch has to come after configuration and
 * before the queue: launch is what opens the
 * connection, and a queue is a row DBOS writes
 * through it. Registering the queue first fails
 * outright, which is what
 * `test/integration/startup.integration.test.ts`
 * demonstrates.
 */
export async function startWorker(config: WorkerConfig): Promise<void> {
  DBOS.setConfig(config);
  await DBOS.launch();
  await DBOS.registerQueue(EMAIL_QUEUE, { workerConcurrency: 1 });
}
