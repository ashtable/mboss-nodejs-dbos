import { parseKeyRing, verifyLink } from '@mboss/core/signed-links';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InternalApiError } from '../../src/api/internal-client.js';
import type { SenderDeps } from '../../src/deps.js';
import { confirmationEmail } from '../../src/workflows/confirmation-email.js';
import { FakeBounceScan } from '../fakes/fake-bounce-scan.js';
import { FakeDeliveryStatus } from '../fakes/fake-delivery-status.js';
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
let bounceScan: FakeBounceScan;
let deps: SenderDeps;
/** True for each clock reading taken inside a step. */
let clockReads: boolean[];

beforeEach(() => {
  reset();
  api = new FakeInternalApi();
  api.seedSubscriber(SUBSCRIBER);
  mailer = new FakeMailer();
  bounceScan = new FakeBounceScan();
  clockReads = [];
  deps = {
    api,
    mailer,
    deliveryStatus: new FakeDeliveryStatus(),
    bounceScanDelays: [3600, 172800],
    startBounceScan: bounceScan.start,
    keyRing: ring,
    siteUrl: 'https://mboss.dev',
    now: () => {
      clockReads.push(inStep());
      return FIXED_NOW;
    },
  };
});

/**
 * What the provider throws when it refuses a
 * message: an ordinary error carrying the HTTP
 * status on `code`, which is where the mailer's
 * own `MailSendError` puts it.
 */
function providerError(code: number): Error {
  return Object.assign(new Error(`provider said ${code}`), { code });
}

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

  it('asks for a bounce scan on the send it made', async () => {
    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    // The operation id is the only handle anything
    // has on this send once the provider has
    // accepted it, and there is no webhook coming.
    expect(bounceScan.scans).toEqual([
      { sends: [{ email: 'pat@stmarks.org', operationId: 'op_1' }] },
    ]);
  });

  it('asks for the scan after the send is recorded', async () => {
    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    // Enqueueing a workflow is not a step, so the
    // ordering is only visible as what had already
    // run when the scan was asked for.
    expect(api.confirmationSent).toEqual(['sub_1']);
    expect(bounceScan.stepsAtStart[0]?.at(-1)).toBe('record-confirmation-sent');
  });

  it('asks for no scan at all when the send failed', async () => {
    mailer.refuse('pat@stmarks.org', new Error('provider refused'));

    await expect(
      confirmationEmail(deps, { subscriberId: 'sub_1' }),
    ).rejects.toThrow('provider refused');

    // There is no operation to poll: the provider
    // never accepted anything.
    expect(bounceScan.scans).toEqual([]);
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

  it('outlasts a sibling API redeploy while fetching the subscriber', async () => {
    api.failNextCalls(
      'getSubscriber',
      7,
      new InternalApiError(503, 'Service Unavailable'),
    );

    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    // This is the workflow that cannot fail
    // cheaply. An error here leaves the send time
    // unset, and the id the API derives from it is
    // the one every later signup derives, so the
    // dead workflow absorbs all of them.
    expect(mailer.sent).toHaveLength(1);
    expect(api.confirmationSent).toEqual(['sub_1']);
  });

  it('retries a send the provider failed with a server error', async () => {
    mailer.refuseOnce('pat@stmarks.org', providerError(503));

    await confirmationEmail(deps, { subscriberId: 'sub_1' });

    expect(mailer.attempted).toHaveLength(2);
    expect(mailer.sent).toHaveLength(1);
  });

  it('gives up on a send after three attempts, whatever the API budget is', async () => {
    mailer.refuse('pat@stmarks.org', providerError(503));

    await expect(
      confirmationEmail(deps, { subscriberId: 'sub_1' }),
    ).rejects.toThrow('provider said 503');

    // A message the provider keeps refusing is not
    // a service that is briefly away. Waiting
    // longer only delays a failure someone has to
    // see, and every extra attempt is another
    // chance at a duplicate landing in an inbox.
    expect(mailer.attempted).toHaveLength(3);
  });

  it('does not retry a message the provider rejected', async () => {
    // A 400 is a complaint about the message
    // itself. Sending the same one again gets the
    // same answer, three times as slowly.
    mailer.refuse('pat@stmarks.org', providerError(400));

    await expect(
      confirmationEmail(deps, { subscriberId: 'sub_1' }),
    ).rejects.toMatchObject({ code: 400 });

    expect(mailer.attempted).toHaveLength(1);
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
