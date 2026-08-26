import { DBOS } from '@dbos-inc/dbos-sdk';
import { renderConfirmationEmail } from '@mboss/core/email';
import type { InternalSubscriberResponse } from '@mboss/zod';

import type { WorkerDeps } from '../deps.js';
import { isTransientSendFailure } from '../email/mailer.js';
import type { SendReceipt } from '../email/mailer.js';
import { manageUrl, mintManageToken } from '../links.js';
import { RETRY_THE_API } from './retry.js';

export type ConfirmationEmailInput = {
  subscriberId: string;
};

/**
 * Sends one person the confirmation for the
 * signup they just made.
 *
 * There is no eligibility check here on purpose.
 * Whether this address should be mailed at all —
 * the resend window, a bounce, a repeat submit —
 * was decided before the workflow was enqueued.
 * Deciding it again here would put the same rule
 * in two repos and let them disagree.
 */
export async function confirmationEmail(
  deps: WorkerDeps,
  input: ConfirmationEmailInput,
): Promise<void> {
  const subscriber = await DBOS.runStep(
    () => deps.api.getSubscriber(input.subscriberId),
    { name: 'fetch-subscriber', ...RETRY_THE_API },
  );

  // This send retries where a broadcast's does
  // not. A confirmation that never arrives breaks
  // a signup and nobody finds out; a second copy
  // of it is merely odd. In a broadcast the trade
  // runs the other way — a failure there lands on
  // the delivery row where an admin can see it.
  await DBOS.runStep(() => sendConfirmation(deps, subscriber), {
    name: 'send-confirmation',
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
    backoffRate: 2,
    shouldRetry: isTransientSendFailure,
  });

  await DBOS.runStep(() => deps.api.recordConfirmationSent(subscriber.id), {
    name: 'record-confirmation-sent',
    ...RETRY_THE_API,
  });
}

/**
 * Minting reads the clock, so it belongs in the
 * step alongside the send rather than in the
 * workflow body, where a replay would produce a
 * different token every time.
 *
 * The provider's receipt comes back rather than
 * being dropped: the provider accepting a message
 * is not the same as anyone receiving it, and the
 * operation id is the only handle on this send
 * afterwards.
 */
async function sendConfirmation(
  deps: WorkerDeps,
  subscriber: InternalSubscriberResponse,
): Promise<SendReceipt> {
  const token = mintManageToken(deps.keyRing, {
    subscriberId: subscriber.id,
    tokenVersion: subscriber.tokenVersion,
    now: deps.now(),
  });

  return deps.mailer.send(
    renderConfirmationEmail({
      to: subscriber.email,
      manageUrl: manageUrl(deps.siteUrl, token),
    }),
  );
}
