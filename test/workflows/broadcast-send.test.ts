import { DeliveryFlipRequestSchema } from '@mboss/zod';
import type { InternalRecipient, SubscriberStatus } from '@mboss/zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InternalApiError } from '../../src/api/internal-client.js';
import type { SenderDeps } from '../../src/deps.js';
import { broadcastSend } from '../../src/workflows/broadcast-send.js';
import { FakeBounceScan } from '../fakes/fake-bounce-scan.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { testSenderDeps } from '../helpers/deps.js';
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
let bounceScan: FakeBounceScan;

/**
 * A broadcast seeded with the given recipients,
 * ready to run. `audience` and `pageSize` are the
 * two things the tests vary.
 */
function seed(
  recipients: InternalRecipient[],
  options: { audience?: SubscriberStatus[]; pageSize?: number } = {},
): { api: FakeInternalApi; deps: SenderDeps } {
  const api = new FakeInternalApi(options.pageSize ?? 100);
  api.seedBroadcast(
    { ...BROADCAST, audience: options.audience ?? ['subscribed'] },
    recipients,
  );
  mailer = new FakeMailer();
  bounceScan = new FakeBounceScan();
  return { api, deps: testSenderDeps({ api, mailer, bounceScan }) };
}

function stepNames(): string[] {
  return steps.map((step) => step.name);
}

/** Every attempt at the broadcast fetch, retries included. */
function broadcastFetches(api: FakeInternalApi): string[] {
  return api.calls.filter((call) => call.startsWith('getBroadcast'));
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
      'flip:sub_1',
      'send:sub_2',
      'flip:sub_2',
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
      'flip:sub_1',
      'fetch-recipients:2',
      'send:sub_2',
      'flip:sub_2',
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

  it('sends to a bounced address when the audience asks for one', async () => {
    // Set membership is the whole rule. A
    // suppression list keyed on 'bounced' would
    // quietly overrule the audience an admin
    // chose, and a re-engagement send would mail
    // nobody at all.
    const { api, deps } = seed([recipient('sub_1', 'bounced')], {
      audience: ['bounced'],
    });

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(api.statusOf('bc_1', 'sub_1')).toBe('sent');
    expect(mailer.toAddress('sub_1@example.com')).toHaveLength(1);
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
    reset();
    await broadcastSend(deps, { broadcastId: 'bc_1' });

    // The pending set is re-derived from the API
    // on every run and never remembered here, so
    // the second run pages, is handed nothing, and
    // issues no per-recipient step at all. Naming
    // the whole sequence says that about the
    // worker rather than about the fake's filter.
    expect(afterFirstRun).toBe(2);
    expect(stepNames()).toEqual([
      'fetch-broadcast',
      'fetch-recipients:1',
      'complete',
    ]);
    expect(mailer.sent).toHaveLength(2);
    expect(api.completeCalls).toHaveLength(2);
  });

  it('finishes the broadcast when a flip fails transiently', async () => {
    // The send is the step that must not be
    // retried; the flip that records it is
    // idempotent server-side, so a blip there has
    // to be survivable or one 503 costs the rest
    // of the audience their email.
    const { api, deps } = seed([recipient('sub_1'), recipient('sub_2')]);
    api.failNextCall(
      'flipDelivery',
      new InternalApiError(503, 'Service Unavailable'),
    );

    await expect(
      broadcastSend(deps, { broadcastId: 'bc_1' }),
    ).resolves.toBeUndefined();

    expect(api.statusOf('bc_1', 'sub_1')).toBe('sent');
    expect(api.statusOf('bc_1', 'sub_2')).toBe('sent');
    expect(api.completeCalls).toEqual(['bc_1']);
    expect(mailer.toAddress('sub_1@example.com')).toHaveLength(1);
  });

  it('stops the run when a flip is refused outright, and a later run picks up where it stopped', async () => {
    const { api, deps } = seed([
      recipient('sub_1'),
      recipient('sub_2'),
      recipient('sub_3'),
    ]);
    api.failNextCall('flipDelivery', new InternalApiError(404, 'Not Found'));

    await expect(
      broadcastSend(deps, { broadcastId: 'bc_1' }),
    ).rejects.toMatchObject({ status: 404 });

    // Nothing completed and nothing fabricated:
    // the run ends at the recipient it could not
    // account for, and that row is still pending.
    expect(stepNames()).toEqual([
      'fetch-broadcast',
      'fetch-recipients:1',
      'send:sub_1',
      'flip:sub_1',
    ]);
    expect(api.completeCalls).toEqual([]);
    expect(api.statusOf('bc_1', 'sub_1')).toBe('pending');
    expect(mailer.toAddress('sub_2@example.com')).toHaveLength(0);

    reset();
    await broadcastSend(deps, { broadcastId: 'bc_1' });

    // Which is what makes stopping cheap: the
    // pending rows are the recipient list, so the
    // rest of the broadcast is still ahead of it.
    // This second run starts over rather than
    // picking the first one back up, so the
    // recipient whose flip was refused is mailed
    // twice; resuming from the step that failed
    // replays the send already recorded and costs
    // nobody a second copy.
    expect(api.statusOf('bc_1', 'sub_1')).toBe('sent');
    expect(api.statusOf('bc_1', 'sub_2')).toBe('sent');
    expect(api.statusOf('bc_1', 'sub_3')).toBe('sent');
    expect(api.completeCalls).toEqual(['bc_1']);
    expect(mailer.toAddress('sub_1@example.com')).toHaveLength(2);
    expect(mailer.toAddress('sub_3@example.com')).toHaveLength(1);
  });

  it('stops the run when a flip runs out of attempts', async () => {
    // The API answering nothing but 5xx for longer
    // than the budget is the failure that actually
    // happens. Carrying on here would mail the
    // whole remaining audience with not one
    // delivery recorded, and mail every one of
    // them again on the next run.
    const { api, deps } = seed([recipient('sub_1'), recipient('sub_2')]);
    api.failNextCalls(
      'flipDelivery',
      20,
      new InternalApiError(503, 'Service Unavailable'),
    );

    await expect(
      broadcastSend(deps, { broadcastId: 'bc_1' }),
    ).rejects.toThrow();

    expect(api.completeCalls).toEqual([]);
    expect(mailer.toAddress('sub_2@example.com')).toHaveLength(0);
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

  it('asks for one bounce scan covering everyone it sent to', async () => {
    const { deps } = seed([recipient('sub_1'), recipient('sub_2')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    // One scan per broadcast, not one per
    // recipient: a scan is two days of sleeping,
    // and an audience of a thousand would be a
    // thousand of them.
    expect(bounceScan.scans).toEqual([
      {
        sends: [
          { email: 'sub_1@example.com', operationId: 'op_1' },
          { email: 'sub_2@example.com', operationId: 'op_2' },
        ],
      },
    ]);
  });

  it('leaves the skipped and the failed out of the scan', async () => {
    const { deps } = seed([
      recipient('sub_1'),
      recipient('sub_2', 'unsubscribed'),
      recipient('sub_3'),
    ]);
    mailer.refuse('sub_3@example.com', new Error('provider refused'));

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    // Neither has an operation behind it: one was
    // never sent, and the other the provider
    // refused.
    expect(bounceScan.scans).toEqual([
      { sends: [{ email: 'sub_1@example.com', operationId: 'op_1' }] },
    ]);
  });

  it('asks for no scan when the broadcast sent to nobody', async () => {
    const { deps } = seed([recipient('sub_1', 'unsubscribed')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(bounceScan.scans).toEqual([]);
  });

  it('asks for the scan after the broadcast is complete', async () => {
    const { api, deps } = seed([recipient('sub_1')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    // A scan asked for mid-run would be enqueued
    // by a workflow that can still stop at the
    // next recipient it cannot account for.
    expect(api.completeCalls).toEqual(['bc_1']);
    expect(stepNames().at(-1)).toBe('complete');
    expect(bounceScan.scans).toHaveLength(1);
  });

  it('asks for no scan when the run stopped early', async () => {
    const { api, deps } = seed([recipient('sub_1'), recipient('sub_2')]);
    api.failNextCall('flipDelivery', new InternalApiError(404, 'Not Found'));

    await expect(
      broadcastSend(deps, { broadcastId: 'bc_1' }),
    ).rejects.toMatchObject({ status: 404 });

    expect(bounceScan.scans).toEqual([]);
  });

  it('retries an internal-API call that answered with a server error', async () => {
    const { api, deps } = seed([recipient('sub_1')]);
    api.failNextCall('getBroadcast', new InternalApiError(503, 'nope'));

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    expect(broadcastFetches(api)).toHaveLength(2);
  });

  it('gives up on an internal-API call only after eight attempts', async () => {
    // Three attempts a second apart is three
    // seconds of patience for the one service
    // these calls reach, and it is gone for tens
    // of seconds every time it ships.
    const { api, deps } = seed([recipient('sub_1')]);
    api.failNextCalls(
      'getBroadcast',
      20,
      new InternalApiError(503, 'Service Unavailable'),
    );

    await expect(
      broadcastSend(deps, { broadcastId: 'bc_1' }),
    ).rejects.toThrow();

    expect(broadcastFetches(api)).toHaveLength(8);
  });

  it('does not retry an internal-API call that answered 404', async () => {
    // A 404 for a broadcast id will be a 404 next
    // time too. Retrying it only delays the
    // failure the admin needs to see.
    const { api, deps } = seed([]);

    await expect(
      broadcastSend(deps, { broadcastId: 'missing' }),
    ).rejects.toMatchObject({ status: 404 });

    expect(broadcastFetches(api)).toHaveLength(1);
  });

  it('does not retry the send, and does retry the flip recording it', async () => {
    const { deps } = seed([recipient('sub_1'), recipient('sub_2')]);

    await broadcastSend(deps, { broadcastId: 'bc_1' });

    // A retry after a send the provider already
    // accepted would deliver a second copy, so the
    // send stays un-retried; the flip is a
    // conditional update, so it retries like every
    // other call into the API. This stops either
    // half being changed by a well-meaning edit.
    const sends = steps.filter((step) => step.name.startsWith('send:'));
    expect(sends).toHaveLength(2);
    expect(sends.every((step) => step.config['retriesAllowed'] === false)).toBe(
      true,
    );

    const flips = steps.filter((step) => step.name.startsWith('flip:'));
    expect(flips).toHaveLength(2);
    expect(flips.every((step) => step.config['retriesAllowed'] === true)).toBe(
      true,
    );
  });
});
