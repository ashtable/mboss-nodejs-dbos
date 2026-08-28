import { DBOS } from '@dbos-inc/dbos-sdk';

import type { WorkerDeps } from '../deps.js';
import type { DeliveryState } from '../email/delivery-status.js';
import { isTransientSendFailure, MailSendError } from '../email/mailer.js';
import { EMAIL_STATUS_QUEUE } from '../worker.js';
import { RETRY_THE_API } from './retry.js';

/** One accepted send, and where to look it up. */
type Send = { email: string; operationId: string };

/**
 * Nothing else is carried on purpose. There is no
 * token version here to gate on and no bounce
 * history to filter by: whether a bounce suppresses
 * an address, and what that does to their links, is
 * the API's rule and lives in one place. This
 * workflow reports what the provider said and
 * nothing more.
 */
export type BounceScanInput = { sends: Send[] };

export type StartBounceScan = (input: BounceScanInput) => Promise<void>;

/**
 * Finds out which of a batch of accepted sends
 * bounced, and tells the API.
 *
 * This provider has no webhook, so a poll is the
 * only way a bounce is ever heard about. It runs
 * on its own queue and spends nearly all of its
 * life asleep between two passes: one an hour
 * after the send, for the refusals that come back
 * immediately, and one two days later, for the
 * ones a receiving server takes its time over.
 *
 * The sleeps and the loop are in the workflow body
 * rather than in a step because DBOS allows neither
 * a durable sleep nor a workflow start from inside
 * a step — a sleep in a step is an ordinary timer
 * that a restart forgets. Only the read and the
 * post are steps.
 */
export async function bounceScan(
  deps: WorkerDeps,
  input: BounceScanInput,
): Promise<void> {
  let pending = input.sends;
  let elapsed = 0;

  for (const [pass, offset] of deps.bounceScanDelays.entries()) {
    if (pending.length === 0) return;

    // The delays are offsets from the moment the
    // scan was enqueued, so what is slept is the
    // difference between this one and the last.
    await DBOS.sleepSeconds(offset - elapsed);
    elapsed = offset;

    const states = await readStates(deps, pending, pass + 1);

    // A batch with nothing in it is a 400 from the
    // route, and the destructure is also how the
    // non-empty batch type is satisfied without a
    // cast.
    const [first, ...rest] = pending.filter(
      (_, at) => states[at] === 'bounced',
    );
    if (first !== undefined) {
      await DBOS.runStep(() => postBounces(deps, [first, ...rest]), {
        name: `post-bounces:${pass + 1}`,
        ...RETRY_THE_API,
      });
    }

    pending = pending.filter((_, at) => states[at] === 'pending');
  }
}

/**
 * Starts the scan for the sends a workflow just
 * made, on the queue that exists to keep sleeping
 * scans out of the way of live email.
 *
 * The id is derived from the sender's own, so a
 * sender that is replayed asks for the same scan
 * rather than a second one, and the provider's
 * records are read once however many times the
 * send workflow resumes.
 */
export function startBounceScanOn(
  scan: (input: BounceScanInput) => Promise<void>,
): StartBounceScan {
  return async (input) => {
    const id = `bounce-scan:${DBOS.workflowID}`;
    await DBOS.startWorkflow(scan, {
      workflowID: id,
      queueName: EMAIL_STATUS_QUEUE,
      enqueueOptions: { deduplicationID: id },
      duplicationPolicy: 'return-existing',
    })(input);
  };
}

/**
 * Where each still-pending send got to, in the
 * order it was asked about.
 *
 * The reads are one step for the whole pass, and a
 * provider that refuses that step refuses every
 * send in it — an operation it has never heard of
 * comes back as an empty list, not as an error. So
 * a refusal that has spent its attempts means "we
 * could not tell", which is the same thing to this
 * workflow as "not settled yet": the pass counts
 * as all-pending and the next one asks again.
 * Throwing instead would strand the later pass and
 * leave a red workflow for something no operator
 * can act on.
 *
 * Only the provider's refusals are read that way.
 * A cancelled workflow, or a fault of our own in
 * the reader, is not a send that has yet to settle,
 * and calling one "pending" would hide a scan that
 * never works behind one that is merely waiting.
 *
 * The policy is written here rather than taken
 * from `retry.ts` because it is about the mail
 * provider, not the API: three attempts, because a
 * provider that has refused twice will refuse a
 * third time, and this scan has two days to spare
 * anyway.
 */
async function readStates(
  deps: WorkerDeps,
  sends: Send[],
  pass: number,
): Promise<DeliveryState[]> {
  try {
    return await DBOS.runStep(
      async () => {
        // One at a time: a broadcast's batch is as
        // long as its audience, and asking about
        // all of them at once is how a scan earns
        // a rate limit.
        const states: DeliveryState[] = [];
        for (const send of sends) {
          states.push(await deps.deliveryStatus.read(send.operationId));
        }
        return states;
      },
      {
        name: `read-status:${pass}`,
        retriesAllowed: true,
        maxAttempts: 3,
        intervalSeconds: 1,
        backoffRate: 2,
        shouldRetry: isTransientSendFailure,
      },
    );
  } catch (error) {
    if (!isProviderRefusal(error)) throw error;
    return sends.map(() => 'pending');
  }
}

/**
 * Whether a failed read was the provider saying no,
 * rather than one of the other things that can come
 * out of a step.
 *
 * A step the retry policy declined to repeat throws
 * the refusal itself. One that spent every attempt
 * throws an error of the SDK's own instead, which
 * carries the attempts it made on `errors`. That
 * one is matched by shape rather than by class:
 * the class sits behind the SDK's error namespace,
 * and reaching for it here would tie this file to
 * the module the workflow tests replace wholesale.
 *
 * Every one of those attempts has to be a refusal.
 * A batch where some other fault crept in is not a
 * batch the provider merely would not answer.
 */
function isProviderRefusal(error: unknown): boolean {
  if (error instanceof MailSendError) return true;
  if (typeof error !== 'object' || error === null) return false;

  const attempts = (error as { errors?: unknown }).errors;
  return (
    Array.isArray(attempts) &&
    attempts.length > 0 &&
    attempts.every((cause) => cause instanceof MailSendError)
  );
}

/**
 * The timestamp is minted here, inside the step,
 * rather than in the workflow body: it is stamped
 * on a subscriber, and a body that reads the clock
 * reads a different one on every replay.
 *
 * It is one reading for the whole batch because
 * that is what it is — the moment this pass found
 * these addresses bounced. The provider's own
 * bounce time is not on the record it hands back.
 */
async function postBounces(
  deps: WorkerDeps,
  bounced: [Send, ...Send[]],
): Promise<void> {
  const timestamp = Math.floor(deps.now().getTime() / 1000);
  const [first, ...rest] = bounced;
  const asEvent = (send: Send) => ({
    email: send.email,
    event: 'bounce' as const,
    timestamp,
  });

  await deps.api.postEmailEvents([asEvent(first), ...rest.map(asEvent)]);
}
