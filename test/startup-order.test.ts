import { beforeEach, describe, expect, it, vi } from 'vitest';

import { calls, reset } from './helpers/dbos-double.js';
import { EMAIL_QUEUE, startWorker } from '../src/worker.js';

vi.mock(
  '@dbos-inc/dbos-sdk',
  async () => await import('./helpers/dbos-double.js'),
);

function indexOf(kind: string): number {
  return calls.findIndex((call) => call.kind === kind);
}

describe('startWorker', () => {
  beforeEach(async () => {
    reset();
    await startWorker({
      name: 'mboss-dbos',
      systemDatabaseUrl: 'postgres://postgres:mboss@localhost:5432/mboss',
    });
  });

  it('configures DBOS before launching', () => {
    expect(indexOf('setConfig')).toBeGreaterThanOrEqual(0);
    expect(indexOf('setConfig')).toBeLessThan(indexOf('launch'));
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
});
