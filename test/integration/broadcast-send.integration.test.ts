import { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { InternalRecipient } from '@mboss/zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMAIL_QUEUE, startWorker } from '../../src/worker.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { testDeps } from '../helpers/deps.js';
import { BROADCAST } from '../helpers/fixtures.js';
import { resetTestDatabase, shutdownDbos } from './helpers/dbos.js';

const RECIPIENTS: InternalRecipient[] = [
  {
    subscriberId: 'sub_1',
    email: 'a@example.com',
    tokenVersion: 1,
    currentStatus: 'subscribed',
  },
  {
    subscriberId: 'sub_2',
    email: 'b@example.com',
    tokenVersion: 1,
    currentStatus: 'subscribed',
  },
];

/**
 * The broadcast half of the cross-repo contract,
 * plus the one guarantee only DBOS can give: that
 * re-enqueuing a workflow id it has already
 * finished sends nothing a second time.
 */
describe('the broadcast workflows against a real system database', () => {
  let client: DBOSClient;
  let api: FakeInternalApi;
  let mailer: FakeMailer;

  beforeEach(async () => {
    const systemDatabaseUrl = await resetTestDatabase();

    api = new FakeInternalApi();
    api.seedBroadcast(BROADCAST, RECIPIENTS);
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

  async function enqueueBroadcast(): Promise<void> {
    const handle = await client.enqueue(
      {
        workflowName: 'broadcastSend',
        queueName: EMAIL_QUEUE,
        workflowID: `broadcast:${BROADCAST.id}`,
      },
      { broadcastId: BROADCAST.id },
    );
    await handle.getResult();
  }

  async function enqueueTestSend(): Promise<void> {
    const handle = await client.enqueue(
      { workflowName: 'broadcastTestSend', queueName: EMAIL_QUEUE },
      {
        subject: BROADCAST.subject,
        bodyMarkdown: BROADCAST.bodyMarkdown,
        to: 'admin@mboss.dev',
      },
    );
    await handle.getResult();
  }

  it('runs a broadcast the API enqueues by name', async () => {
    await enqueueBroadcast();

    expect(mailer.sent.map((message) => message.to)).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
    expect(api.completeCalls).toEqual([BROADCAST.id]);
  });

  it('does not re-send when the same workflow id runs again', async () => {
    await enqueueBroadcast();
    await enqueueBroadcast();

    expect(mailer.sent).toHaveLength(2);
  });

  it('runs a test send twice when enqueued twice without an id', async () => {
    await enqueueTestSend();
    await enqueueTestSend();

    // No workflow id means no idempotency, which
    // is the point: an admin asking twice wants
    // two emails.
    expect(mailer.toAddress('admin@mboss.dev')).toHaveLength(2);
  });
});
