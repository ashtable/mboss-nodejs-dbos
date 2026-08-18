import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InternalApiError } from '../../src/api/internal-client.js';
import { EMAIL_QUEUE, startWorker } from '../../src/worker.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { testDeps } from '../helpers/deps.js';
import { SUBSCRIBER } from '../helpers/fixtures.js';
import { resetTestDatabase, shutdownDbos } from './helpers/dbos.js';

/**
 * The recovery the README hands an operator, run
 * against a real system database. None of it is
 * this repo's own behaviour — it is what DBOS
 * does with a workflow that has errored — which
 * is exactly why it earns a test: an upgrade that
 * changes any of it leaves those instructions
 * wrong at the one moment somebody is following
 * them.
 */
describe('recovering an errored confirmation', () => {
  const WORKFLOW_ID = 'confirm:sub_1:0';

  let client: DBOSClient;
  let api: FakeInternalApi;
  let mailer: FakeMailer;

  async function enqueue(): Promise<void> {
    const handle = await client.enqueue(
      {
        workflowName: 'confirmationEmail',
        queueName: EMAIL_QUEUE,
        workflowID: WORKFLOW_ID,
      },
      { subscriberId: SUBSCRIBER.id },
    );
    await handle.getResult();
  }

  /** The step that threw, which a fork starts from. */
  async function failedStep(): Promise<number> {
    const steps = (await client.listWorkflowSteps(WORKFLOW_ID)) ?? [];

    // Every step that succeeded records a null
    // error, so the one that did not is the one
    // this listing is read for.
    const failed = steps.find((step) => step.error !== null);
    expect(failed?.name).toBe('record-confirmation-sent');
    return failed?.functionID ?? -1;
  }

  /**
   * A second failure, later than the first, so
   * the listing has an old one and a new one. A
   * 4xx is not retried, so this one gives up on
   * its first step.
   */
  async function seedLaterFailure(workflowID: string): Promise<void> {
    api.failNextCall('getSubscriber', new InternalApiError(400, 'Bad Request'));

    const handle = await client.enqueue(
      { workflowName: 'confirmationEmail', queueName: EMAIL_QUEUE, workflowID },
      { subscriberId: SUBSCRIBER.id },
    );
    await expect(handle.getResult()).rejects.toThrow();
  }

  beforeEach(async () => {
    const systemDatabaseUrl = await resetTestDatabase();

    api = new FakeInternalApi();
    api.seedSubscriber(SUBSCRIBER);
    // The send lands and the record of it does
    // not, which is the failure that strands a
    // subscriber: the send time stays unset, so
    // every later signup derives this same id.
    api.failNextCall(
      'recordConfirmationSent',
      new InternalApiError(400, 'Bad Request'),
    );
    mailer = new FakeMailer();

    await startWorker(testDeps({ api, mailer }), {
      name: 'mboss-dbos-test',
      systemDatabaseUrl,
    });
    client = await DBOSClient.create({ systemDatabaseUrl });

    await expect(enqueue()).rejects.toThrow();
    await expect
      .poll(async () => (await client.getWorkflow(WORKFLOW_ID))?.status)
      .toBe('ERROR');
  });

  afterEach(async () => {
    await client.destroy();
    await shutdownDbos();
  });

  it('sends nothing when a later signup re-enqueues the same id', async () => {
    await expect(enqueue()).rejects.toThrow();

    // The id is derived from a send time that is
    // still unset, so it is the same id, and the
    // enqueue attaches to the errored workflow
    // rather than starting anything.
    expect(mailer.sent).toHaveLength(1);
    expect(api.confirmationSent).toEqual([]);
  });

  it('is left errored by resume', async () => {
    await client.resumeWorkflow(WORKFLOW_ID);

    // Resume updates only workflows that are
    // neither finished nor errored, so here it
    // matches no rows, raises nothing and reports
    // nothing. An operator sent to it would read
    // success and have changed nothing.
    expect((await client.getWorkflow(WORKFLOW_ID))?.status).toBe('ERROR');
    expect(api.confirmationSent).toEqual([]);
  });

  it('finishes when forked from the step that failed', async () => {
    const forkedID = await client.forkWorkflow(WORKFLOW_ID, await failedStep());
    await client.retrieveWorkflow(forkedID).getResult();

    expect(api.confirmationSent).toEqual([SUBSCRIBER.id]);
    // Steps before the fork point are copied
    // rather than run again, so a failure after
    // the send does not cost the subscriber a
    // second email.
    expect(mailer.sent).toHaveLength(1);
  });

  it('puts the oldest failure first, so a limit hides the newest', async () => {
    const NEWER_ID = 'confirm:sub_1:1';
    await seedLaterFailure(NEWER_ID);

    const listed = await client.listWorkflows({ status: 'ERROR', limit: 100 });
    expect(listed.map((workflow) => workflow.workflowID)).toEqual([
      WORKFLOW_ID,
      NEWER_ID,
    ]);

    // Oldest first, and nothing on the CLI turns
    // that around, so whatever limit it sends —
    // ten, unless it is told otherwise — takes
    // from the old end and drops the newest
    // failure, the one somebody is looking for.
    const page = await client.listWorkflows({ status: 'ERROR', limit: 1 });
    expect(page.map((workflow) => workflow.workflowID)).toEqual([WORKFLOW_ID]);
  });
});
