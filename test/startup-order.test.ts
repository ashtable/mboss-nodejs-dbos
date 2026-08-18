import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMAIL_QUEUE, startWorker } from '../src/worker.js';
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

  /**
   * The other side of this contract is the three
   * `enqueue({ workflowName: … })` literals in
   * `mboss-nodejs-api`'s waitlist and admin
   * routes. Nothing but these strings connects
   * the two repos, and a typo in either one is
   * silent: the API enqueues a name DBOS has
   * never heard of, and no email is ever sent.
   */
  it('registers exactly the workflows the API enqueues', () => {
    expect(registeredNames()).toEqual(['confirmationEmail']);
  });
});
