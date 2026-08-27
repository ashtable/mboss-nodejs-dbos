import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMAIL_QUEUE, EMAIL_STATUS_QUEUE, startWorker } from '../src/worker.js';
import { calls, reset } from './helpers/dbos-double.js';
import { testDeps } from './helpers/deps.js';

vi.mock(
  '@dbos-inc/dbos-sdk',
  async () => await import('./helpers/dbos-double.js'),
);

const deps = testDeps();

function indexOf(kind: string): number {
  return calls.findIndex((call) => call.kind === kind);
}

function registeredNames(): string[] {
  return calls
    .filter((call) => call.kind === 'registerWorkflow')
    .map((call) => call.name);
}

describe('startWorker', () => {
  beforeEach(async () => {
    reset();
    await startWorker(deps, {
      name: 'mboss-dbos',
      systemDatabaseUrl: 'postgres://postgres:mboss@localhost:5432/mboss',
    });
  });

  it('configures DBOS before launching', () => {
    expect(indexOf('setConfig')).toBeGreaterThanOrEqual(0);
    expect(indexOf('setConfig')).toBeLessThan(indexOf('launch'));
  });

  it('registers its workflows before launching', () => {
    expect(indexOf('registerWorkflow')).toBeGreaterThanOrEqual(0);
    expect(indexOf('registerWorkflow')).toBeLessThan(indexOf('launch'));
  });

  it('launches before it registers the queue', () => {
    expect(indexOf('launch')).toBeGreaterThanOrEqual(0);
    expect(indexOf('launch')).toBeLessThan(indexOf('registerQueue'));
  });

  it('registers the email queue with one worker', () => {
    expect(calls).toContainEqual({
      kind: 'registerQueue',
      name: EMAIL_QUEUE,
      options: { workerConcurrency: 1 },
    });
    expect(EMAIL_QUEUE).toBe('email');
  });

  it('registers the bounce scan queue uncapped', () => {
    // A scan is two days of sleeping. Capped, one
    // of them would hold a slot that every
    // outgoing email is waiting on.
    expect(calls).toContainEqual({
      kind: 'registerQueue',
      name: EMAIL_STATUS_QUEUE,
      options: undefined,
    });
    expect(EMAIL_STATUS_QUEUE).toBe('email-status');
  });

  /**
   * Three of these names are the contract with
   * `mboss-nodejs-api`: they are the
   * `enqueue({ workflowName: … })` literals in its
   * waitlist and admin routes. Nothing but the
   * strings connects the two repos, and a typo in
   * either one is silent — the API enqueues a name
   * DBOS has never heard of, and no email is ever
   * sent.
   *
   * `bounceScan` is the fourth, and this worker
   * enqueues it itself. It is registered first
   * because the senders cannot be given a way to
   * start it until it exists.
   */
  it('registers exactly the workflows that get enqueued', () => {
    expect(registeredNames()).toEqual([
      'bounceScan',
      'confirmationEmail',
      'broadcastSend',
      'broadcastTestSend',
    ]);
  });
});
