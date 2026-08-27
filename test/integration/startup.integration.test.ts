import { DBOS } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  queryTestDatabase,
  resetTestDatabase,
  shutdownDbos,
} from './helpers/dbos.js';
import {
  EMAIL_QUEUE,
  EMAIL_STATUS_QUEUE,
  startWorker,
} from '../../src/worker.js';
import { testDeps } from '../helpers/deps.js';

/**
 * What this file proves is DBOS's behaviour, not
 * this repo's: that the system tables land where
 * the deployment assumes they do, and that the
 * launch-then-queue order in `startWorker` is
 * load-bearing rather than decorative. A doubled
 * SDK can make neither claim, which is why these
 * four tests need a real Postgres and stay out
 * of CI.
 */
describe('worker startup against a real system database', () => {
  let systemDatabaseUrl: string;

  beforeEach(async () => {
    systemDatabaseUrl = await resetTestDatabase();
    // A table nothing but this test owns, so
    // "public is untouched" is an assertion about
    // a known set rather than about emptiness.
    await queryTestDatabase('CREATE TABLE public.sentinel (id integer)');
  });

  afterEach(async () => {
    await shutdownDbos();
  });

  it('creates its system tables in the dbos schema and leaves public alone', async () => {
    await startWorker(testDeps(), {
      name: 'mboss-dbos-test',
      systemDatabaseUrl,
    });

    const tables = await queryTestDatabase<{
      table_schema: string;
      table_name: string;
    }>(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema IN ('dbos', 'public')`,
    );

    expect(
      tables.filter((table) => table.table_schema === 'dbos').length,
    ).toBeGreaterThan(0);
    expect(
      tables
        .filter((table) => table.table_schema === 'public')
        .map((table) => table.table_name),
    ).toEqual(['sentinel']);
  });

  it('refuses to register a queue before launch', async () => {
    await expect(
      DBOS.registerQueue(EMAIL_QUEUE, { workerConcurrency: 1 }),
    ).rejects.toThrow('`DBOS.launch()` must be called before running');
  });

  it('registers the email queue against the system database', async () => {
    await startWorker(testDeps(), {
      name: 'mboss-dbos-test',
      systemDatabaseUrl,
    });

    await expect(DBOS.retrieveQueue(EMAIL_QUEUE)).resolves.not.toBeNull();
  });

  it('registers the bounce scan queue against the system database', async () => {
    await startWorker(testDeps(), {
      name: 'mboss-dbos-test',
      systemDatabaseUrl,
    });

    await expect(
      DBOS.retrieveQueue(EMAIL_STATUS_QUEUE),
    ).resolves.not.toBeNull();
  });
});
