import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMAIL_QUEUE, startWorker } from '../../src/worker.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { testDeps } from '../helpers/deps.js';
import { SUBSCRIBER } from '../helpers/fixtures.js';
import {
  queryTestDatabase,
  resetTestDatabase,
  shutdownDbos,
} from './helpers/dbos.js';

/**
 * The only test in either repo that proves the
 * cross-repo contract: the API enqueues
 * `confirmationEmail` on queue `email` by string
 * name and nothing checks that against what this
 * worker registers. Here a real client enqueues
 * exactly the way the API does, and a real worker
 * either picks it up or does not.
 *
 * The internal API and the mailer are still
 * doubles. What is real is DBOS.
 */
describe('confirmationEmail against a real system database', () => {
  let systemDatabaseUrl: string;
  let client: DBOSClient;
  let mailer: FakeMailer;

  beforeEach(async () => {
    systemDatabaseUrl = await resetTestDatabase();

    const api = new FakeInternalApi();
    api.seedSubscriber(SUBSCRIBER);
    mailer = new FakeMailer();

    await startWorker(testDeps({ api, mailer }), {
      name: 'mboss-dbos-test',
      systemDatabaseUrl,
    });
    client = await DBOSClient.create({ systemDatabaseUrl });
  });

  afterEach(async () => {
    await client.destroy();
    await shutdownDbos();
  });

  /** Exactly the shape the API's own enqueue has. */
  async function enqueueConfirmation(workflowID: string): Promise<void> {
    const handle = await client.enqueue(
      { workflowName: 'confirmationEmail', queueName: EMAIL_QUEUE, workflowID },
      { subscriberId: SUBSCRIBER.id },
    );
    await handle.getResult();
  }

  it('runs a workflow the API enqueues by name', async () => {
    await enqueueConfirmation('confirm:sub_1:0');

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(SUBSCRIBER.email);
  });

  it('runs once for a workflow id it has already seen', async () => {
    await enqueueConfirmation('confirm:sub_1:0');
    await enqueueConfirmation('confirm:sub_1:0');

    // A workflow id is permanent, so the second
    // enqueue attaches to the finished first one
    // rather than starting a second send. That is
    // what collapses a double signup submit.
    expect(mailer.sent).toHaveLength(1);
  });

  it('registers the workflow without a class name', async () => {
    await enqueueConfirmation('confirm:sub_1:0');

    const rows = await queryTestDatabase<{
      name: string;
      class_name: string | null;
    }>(`SELECT name, class_name FROM dbos.workflow_status ORDER BY name`);

    // The API's enqueue never sends a class name.
    // Register this with one and the enqueue
    // matches nothing at all: the row sits in the
    // queue and no email is ever sent.
    //
    // The scan is the second row because a
    // finished confirmation always leaves one
    // behind: there is no bounce webhook, so the
    // only way this send is ever heard about again
    // is the poll it just enqueued.
    expect(rows).toEqual([
      { name: 'bounceScan', class_name: null },
      { name: 'confirmationEmail', class_name: null },
    ]);
  });
});
