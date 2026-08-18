import { parseKeyRing, verifyLink } from '@mboss/core/signed-links';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerDeps } from '../../src/deps.js';
import { confirmationEmail } from '../../src/workflows/confirmation-email.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { FIXED_NOW, SUBSCRIBER, TEST_LINK_KEYS } from '../helpers/fixtures.js';
import { inStep, reset, steps } from '../helpers/dbos-double.js';

vi.mock(
  '@dbos-inc/dbos-sdk',
  async () => await import('../helpers/dbos-double.js'),
);

const ring = parseKeyRing(TEST_LINK_KEYS);

let api: FakeInternalApi;
let mailer: FakeMailer;
let deps: WorkerDeps;
/** True for each clock reading taken inside a step. */
let clockReads: boolean[];

beforeEach(() => {
  reset();
  api = new FakeInternalApi();
  api.seedSubscriber(SUBSCRIBER);
  mailer = new FakeMailer();
  clockReads = [];
  deps = {
    api,
    mailer,
    keyRing: ring,
    siteUrl: 'https://mboss.dev',
    now: () => {
      clockReads.push(inStep());
      return FIXED_NOW;
    },
  };
});

/** The `/u/<token>` the sent email points at. */
function manageTokenIn(html: string): string {
  return /https:\/\/mboss\.dev\/u\/([A-Za-z0-9_.-]+)/.exec(html)?.[1] ?? '';
}

describe('confirmationEmail', () => {
  it('fetches the subscriber, sends, then records the send', async () => {
    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    expect(steps.map((step) => step.name)).toEqual([
      'fetch-subscriber',
      'send-confirmation',
      'record-confirmation-sent',
    ]);
  });

  it("sends the confirmation to the subscriber's address", async () => {
    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('pat@stmarks.org');
    expect(mailer.sent[0]?.subject).toBe("You're on the mBoss waitlist");
  });

  it('embeds a manage link the ring can verify', async () => {
    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    const result = verifyLink(
      ring,
      manageTokenIn(mailer.sent[0]?.html ?? ''),
      'wl.manage',
    );

    expect(result.ok && result.payload).toMatchObject({
      sub: SUBSCRIBER.id,
      tv: SUBSCRIBER.tokenVersion,
    });
  });

  it('mints the link inside the step, not in the workflow body', async () => {
    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    // Minting is the only thing here that asks
    // for the time, so "every clock reading
    // happened inside a step" is the determinism
    // rule stated in the only terms a test can
    // observe.
    expect(clockReads).toEqual([true]);
  });

  it('records the confirmation against the subscriber', async () => {
    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    expect(api.confirmationSent).toEqual(['sub_1']);
  });

  it('declares a retry policy on every step', async () => {
    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    // Retries are off unless a step says
    // otherwise, so an unset policy is a silent
    // decision rather than no decision.
    expect(steps.every((step) => 'retriesAllowed' in step.config)).toBe(true);
  });

  it('lets a failed send fail the workflow', async () => {
    mailer.refuse('pat@stmarks.org', new Error('provider refused'));

    await expect(
      confirmationEmail(deps, { subscriberId: 'sub_1' }),
    ).rejects.toThrow('provider refused');

    // A confirmation is one person's only signal
    // that their signup worked. Recording a send
    // that did not happen would silently cost
    // them the email.
    expect(api.confirmationSent).toEqual([]);
  });
});
