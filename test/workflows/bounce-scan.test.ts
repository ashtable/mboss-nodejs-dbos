import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerDeps } from '../../src/deps.js';
import { MailSendError } from '../../src/email/mailer.js';
import {
  bounceScan,
  startBounceScanOn,
} from '../../src/workflows/bounce-scan.js';
import type { BounceScanInput } from '../../src/workflows/bounce-scan.js';
import { FakeDeliveryStatus } from '../fakes/fake-delivery-status.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { testDeps } from '../helpers/deps.js';
import { FIXED_NOW } from '../helpers/fixtures.js';
import {
  calls,
  inStep,
  reset,
  setWorkflowID,
  sleeps,
  steps,
} from '../helpers/dbos-double.js';

vi.mock(
  '@dbos-inc/dbos-sdk',
  async () => await import('../helpers/dbos-double.js'),
);

const PAT = { email: 'pat@stmarks.org', operationId: 'op_1' };
const SAM = { email: 'sam@stmarks.org', operationId: 'op_2' };

/** `FIXED_NOW` in the epoch seconds the wire takes. */
const FIXED_EPOCH = 1786881600;

let api: FakeInternalApi;
let deliveryStatus: FakeDeliveryStatus;
let deps: WorkerDeps;
/** True for each clock reading taken inside a step. */
let clockReads: boolean[];

function stepNames(): string[] {
  return steps.map((step) => step.name);
}

function posts(): string[] {
  return api.calls.filter((call) => call.startsWith('postEmailEvents'));
}

/**
 * What the SDK throws for a step that spent every
 * attempt: one error carrying the run of them.
 *
 * Built by hand rather than imported, because these
 * tests replace the SDK module wholesale — and
 * because the double rethrows the last error flat,
 * so this shape would otherwise never reach the
 * code that has to recognise it.
 */
function exhausted(...errors: Error[]): Error {
  return Object.assign(new Error('step spent every attempt'), { errors });
}

beforeEach(() => {
  reset();
  api = new FakeInternalApi();
  deliveryStatus = new FakeDeliveryStatus();
  clockReads = [];
  deps = {
    ...testDeps({ api, deliveryStatus }),
    now: () => {
      clockReads.push(inStep());
      return FIXED_NOW;
    },
  };
});

describe('bounceScan', () => {
  it('sleeps to each offset rather than for each gap', async () => {
    await bounceScan(deps, { sends: [PAT] });

    // The schedule is +1h and +48h from the moment
    // the scan was enqueued, so the second sleep is
    // the difference, not the offset again. This is
    // the one assertion that pins which of the two
    // the numbers mean.
    expect(sleeps).toEqual([3600, 169200]);
  });

  it('looks twice and then gives up on a send that never settles', async () => {
    await bounceScan(deps, { sends: [PAT] });

    expect(stepNames()).toEqual(['read-status:1', 'read-status:2']);
    expect(deliveryStatus.reads).toEqual(['op_1', 'op_1']);
    // Nothing after the last delay: the provider
    // keeps the record for a week, and a bounce
    // that has not surfaced in two days is not
    // going to.
    expect(sleeps).toHaveLength(2);
  });

  it('posts a bounce as soon as a pass finds one', async () => {
    deliveryStatus.seed('op_1', 'bounced');

    await bounceScan(deps, { sends: [PAT] });

    expect(api.emailEvents).toEqual([
      { email: 'pat@stmarks.org', event: 'bounce', timestamp: FIXED_EPOCH },
    ]);
    expect(stepNames()).toEqual(['read-status:1', 'post-bounces:1']);
  });

  it('stops scanning once every send has settled', async () => {
    deliveryStatus.seed('op_1', 'bounced');

    await bounceScan(deps, { sends: [PAT] });

    // A bounced send is as terminal as a delivered
    // one. There is nothing a second pass could
    // learn.
    expect(sleeps).toEqual([3600]);
    expect(deliveryStatus.reads).toEqual(['op_1']);
  });

  it('asks the later pass only about the sends still pending', async () => {
    deliveryStatus.seed('op_1', 'settled');

    await bounceScan(deps, { sends: [PAT, SAM] });

    expect(deliveryStatus.reads).toEqual(['op_1', 'op_2', 'op_2']);
  });

  it('posts nothing at all when nothing bounced', async () => {
    await bounceScan(deps, { sends: [PAT, SAM] });

    // Not even an empty batch: the route answers
    // one with a 400, so a scan that found nothing
    // has to stay quiet rather than post nothing.
    expect(api.emailEvents).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it('mints the bounce timestamp inside a step', async () => {
    deliveryStatus.seed('op_1', 'bounced');

    await bounceScan(deps, { sends: [PAT] });

    // A workflow body that reads the clock reads a
    // different one on every replay, and this
    // number is stamped on a subscriber.
    expect(clockReads).toEqual([true]);
  });

  it('declares a retry policy on every step', async () => {
    deliveryStatus.seed('op_1', 'bounced');

    await bounceScan(deps, { sends: [PAT] });

    expect(steps.every((step) => 'retriesAllowed' in step.config)).toBe(true);
  });

  it('retries a read the provider fumbled once', async () => {
    deliveryStatus.failNextRead(new MailSendError(503, 'Service Unavailable'));
    deliveryStatus.seed('op_1', 'bounced');

    await bounceScan(deps, { sends: [PAT] });

    expect(deliveryStatus.reads).toEqual(['op_1', 'op_1']);
    expect(api.emailEvents).toHaveLength(1);
  });

  it('does not keep asking after a refusal that will not change', async () => {
    // A 400 is a complaint about the request
    // itself. Asking twice more gets the same
    // answer.
    deliveryStatus.failEveryRead(new MailSendError(400, 'not an operation'));

    await bounceScan(deps, { sends: [PAT] });

    expect(deliveryStatus.reads).toEqual(['op_1', 'op_1']);
  });

  it('leaves a send pending when the provider will not answer at all', async () => {
    deliveryStatus.failEveryRead(new MailSendError(503, 'Service Unavailable'));

    // "We could not tell" and "not settled yet" are
    // the same thing to this workflow, so an
    // unreadable pass costs the later pass nothing.
    // Throwing instead would strand the later pass
    // and leave a red workflow nobody can act on.
    await expect(bounceScan(deps, { sends: [PAT] })).resolves.toBeUndefined();

    expect(stepNames()).toEqual(['read-status:1', 'read-status:2']);
    expect(sleeps).toEqual([3600, 169200]);
    expect(api.emailEvents).toEqual([]);
  });

  it('leaves a send pending when every attempt was refused', async () => {
    deliveryStatus.failEveryRead(
      exhausted(
        new MailSendError(503, 'Service Unavailable'),
        new MailSendError(503, 'Service Unavailable'),
      ),
    );

    // What the SDK hands back for a step that spent
    // its attempts, rather than the last refusal on
    // its own. Both mean the provider would not
    // answer, so both count as pending.
    await expect(bounceScan(deps, { sends: [PAT] })).resolves.toBeUndefined();

    expect(sleeps).toEqual([3600, 169200]);
    expect(api.emailEvents).toEqual([]);
  });

  it('lets a failure that is not the provider refusing fail the scan', async () => {
    deliveryStatus.failEveryRead(new TypeError('read is not a function'));

    // Only "the provider would not answer" reads as
    // pending. A fault of our own, or a cancelled
    // workflow, is not an unsettled send, and
    // calling it pending would leave a scan that
    // never works looking like one that is merely
    // waiting.
    await expect(bounceScan(deps, { sends: [PAT] })).rejects.toThrow(
      'read is not a function',
    );
  });

  it('fails the scan when a refused batch hid a fault of ours', async () => {
    deliveryStatus.failEveryRead(
      exhausted(
        new MailSendError(503, 'Service Unavailable'),
        new TypeError('read is not a function'),
      ),
    );

    // One refusal among the attempts does not make
    // the batch a refusal. The other attempt is
    // still a bug nobody would ever hear about.
    await expect(bounceScan(deps, { sends: [PAT] })).rejects.toThrow(
      'spent every attempt',
    );
  });
});

describe('startBounceScanOn', () => {
  it('enqueues the scan under an id derived from the send that started it', async () => {
    setWorkflowID('confirm:sub_1:0');
    const input: BounceScanInput = { sends: [PAT] };
    const scanned: BounceScanInput[] = [];

    await startBounceScanOn(async (given) => {
      scanned.push(given);
    })(input);

    // The derived id is what makes a replayed
    // sender enqueue the same scan rather than a
    // second one.
    expect(calls).toEqual([
      {
        kind: 'startWorkflow',
        params: {
          workflowID: 'bounce-scan:confirm:sub_1:0',
          queueName: 'email-status',
          enqueueOptions: {
            deduplicationID: 'bounce-scan:confirm:sub_1:0',
          },
          duplicationPolicy: 'return-existing',
        },
        input,
      },
    ]);
    // Enqueued, not run: a send must not sit
    // through the scan it started.
    expect(scanned).toEqual([]);
  });
});
