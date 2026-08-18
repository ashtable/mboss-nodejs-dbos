import { DeliveryFlipRequestSchema } from '@mboss/zod';
import type { InternalRecipient, SubscriberStatus } from '@mboss/zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerDeps } from '../../src/deps.js';
import { broadcastSend } from '../../src/workflows/broadcast-send.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { testDeps } from '../helpers/deps.js';
import { BROADCAST } from '../helpers/fixtures.js';
import { reset, steps } from '../helpers/dbos-double.js';

vi.mock(
  '@dbos-inc/dbos-sdk',
  async () => await import('../helpers/dbos-double.js'),
);

function recipient(
  id: string,
  currentStatus: SubscriberStatus = 'subscribed',
): InternalRecipient {
  return {
    subscriberId: id,
    email: `${id}@example.com`,
    tokenVersion: 1,
    currentStatus,
  };
}

let mailer: FakeMailer;

/**
 * A broadcast seeded with the given recipients,
 * ready to run. `audience` and `pageSize` are the
 * two things the tests vary.
 */
function seed(
  recipients: InternalRecipient[],
  options: { audience?: SubscriberStatus[]; pageSize?: number } = {},
): { api: FakeInternalApi; deps: WorkerDeps } {
  const api = new FakeInternalApi(options.pageSize ?? 100);
  api.seedBroadcast(
    { ...BROADCAST, audience: options.audience ?? ['subscribed'] },
    recipients,
  );
  mailer = new FakeMailer();
  return { api, deps: testDeps({ api, mailer }) };
}

function stepNames(): string[] {
  return steps.map((step) => step.name);
}

beforeEach(() => {
  reset();
});

describe('broadcastSend', () => {
  it('fetches the broadcast, pages the recipients, sends, then completes', async () => {
    const { deps } = seed([recipient('sub_1'), recipient('sub_2')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(stepNames()).toEqual([
      'fetch-broadcast',
      'fetch-recipients:1',
      'send:sub_1',
      'send:sub_2',
      'complete',
    ]);
  });

  it('follows the cursor to the next page', async () => {
    const { api, deps } = seed([recipient('sub_1'), recipient('sub_2')], {
      pageSize: 1,
    });

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(stepNames()).toEqual([
      'fetch-broadcast',
      'fetch-recipients:1',
      'send:sub_1',
      'fetch-recipients:2',
      'send:sub_2',
      'complete',
    ]);
    expect(api.calls).toContain('listRecipients:bc_1:sub_1');
  });

  it('records a recipient who left the audience as skipped and sends them nothing', async () => {
    const { api, deps } = seed([recipient('sub_1', 'unsubscribed')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(api.statusOf('bc_1', 'sub_1')).toBe('skipped');
    expect(mailer.toAddress('sub_1@example.com')).toHaveLength(0);
  });

  it('sends to a subscriber who bounced and re-subscribed, because the check is on current status', async () => {
    // The worker sees only the status the
    // recipient is in now. Someone who bounced
    // and signed up again is subscribed, and
    // keying on anything else would suppress them
    // forever.
    const { api, deps } = seed([recipient('sub_bounced_then_back')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(api.statusOf('bc_1', 'sub_bounced_then_back')).toBe('sent');
  });

  it('sends to a paused subscriber when the audience includes paused', async () => {
    const { api, deps } = seed([recipient('sub_1', 'paused')], {
      audience: ['subscribed', 'paused'],
    });

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(api.statusOf('bc_1', 'sub_1')).toBe('sent');
  });

  it('records one failing address as failed and still sends the rest', async () => {
    const { api, deps } = seed([
      recipient('sub_1'),
      recipient('sub_2'),
      recipient('sub_3'),
    ]);
    mailer.refuse('sub_2@example.com', new Error('provider refused'));

    await expect(
      broadcastSend(deps, { broadcastId: 'bc_1' }),
    ).resolves.toBeUndefined();

    expect(api.statusOf('bc_1', 'sub_1')).toBe('sent');
    expect(api.statusOf('bc_1', 'sub_2')).toBe('failed');
    expect(api.statusOf('bc_1', 'sub_3')).toBe('sent');
    expect(
      api.flips.find((flip) => flip.subscriberId === 'sub_2')?.error,
    ).toContain('provider refused');
  });

  it('truncates a long provider error to what the delivery row accepts', async () => {
    const { api, deps } = seed([recipient('sub_1')]);
    mailer.refuse('sub_1@example.com', new Error('x'.repeat(5000)));

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    const flip = api.flips[0];
    expect(flip?.error?.length).toBeLessThanOrEqual(2000);
    expect(DeliveryFlipRequestSchema.safeParse(flip).success).toBe(true);
  });

  it('a second run sends only the rows still pending', async () => {
    const { api, deps } = seed([recipient('sub_1'), recipient('sub_2')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });
    const afterFirstRun = mailer.sent.length;
    await broadcastSend(deps, { broadcastId: 'bc_1' });

    // The pending set is re-derived from the API
    // on every run, never remembered here, so a
    // row that has been flipped is simply not on
    // a later page.
    expect(afterFirstRun).toBe(2);
    expect(mailer.sent).toHaveLength(2);
    expect(api.completeCalls).toHaveLength(2);
  });

  it('keeps going when a flip reports a status the row already had', async () => {
    const { api, deps } = seed([recipient('sub_1'), recipient('sub_2')]);
    api.settleConcurrently('bc_1', 'sub_1', 'failed');

    await expect(
      broadcastSend(deps, { broadcastId: 'bc_1' }),
    ).resolves.toBeUndefined();

    expect(api.statusOf('bc_1', 'sub_1')).toBe('failed');
    expect(api.statusOf('bc_1', 'sub_2')).toBe('sent');
  });

  it('completes the broadcast exactly once', async () => {
    const { api, deps } = seed([recipient('sub_1'), recipient('sub_2')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(api.completeCalls).toEqual(['bc_1']);
    expect(stepNames().at(-1)).toBe('complete');
  });

  it('declares a retry policy on every step', async () => {
    const { deps } = seed([recipient('sub_1')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(steps.every((step) => 'retriesAllowed' in step.config)).toBe(true);
  });

  it('does not retry the per-recipient send', async () => {
    const { deps } = seed([recipient('sub_1'), recipient('sub_2')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    // A retry after a send the provider already
    // accepted would deliver a second copy. The
    // comment on the step says why that window is
    // left as narrow as a crash; this stops it
    // being widened by a well-meaning edit.
    const sends = steps.filter((step) => step.name.startsWith('send:'));
    expect(sends).toHaveLength(2);
    expect(sends.every((step) => step.config['retriesAllowed'] === false)).toBe(
      true,
    );
  });
});
