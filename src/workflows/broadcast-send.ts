import { DBOS } from '@dbos-inc/dbos-sdk';
import type {
  DeliveryFlipRequest,
  InternalBroadcastResponse,
  InternalRecipient,
} from '@mboss/zod';

import type { WorkerDeps } from '../deps.js';
import { renderBroadcastEmail } from '../email/broadcast.js';
import { manageUrl, mintManageToken, unsubscribeUrl } from '../links.js';
import { RETRY_THE_API } from './retry.js';

export type BroadcastSendInput = {
  broadcastId: string;
};

/**
 * The delivery row's `error` column takes this
 * much and no more.
 */
const MAX_ERROR = 2000;

/**
 * Sends one broadcast to everyone still waiting
 * for it.
 *
 * The recipient set is not held here. Every page
 * comes from the API, which returns only rows
 * still pending, so a run that starts over —
 * after a crash, or because an admin re-enqueued
 * — sends exactly what is still outstanding and
 * nothing else.
 */
export async function broadcastSend(
  deps: WorkerDeps,
  input: BroadcastSendInput,
): Promise<void> {
  const broadcast = await DBOS.runStep(
    () => deps.api.getBroadcast(input.broadcastId),
    { name: 'fetch-broadcast', ...RETRY_THE_API },
  );

  let cursor: string | undefined;
  let page = 0;

  do {
    page += 1;
    const after = cursor;
    const recipients = await DBOS.runStep(
      () => deps.api.listRecipients(input.broadcastId, after),
      { name: `fetch-recipients:${page}`, ...RETRY_THE_API },
    );

    for (const row of recipients.rows) {
      await DBOS.runStep(() => sendToRecipient(deps, broadcast, row), {
        name: `send:${row.subscriberId}`,
        retriesAllowed: false,
      });
    }

    cursor = recipients.nextCursor;
  } while (cursor !== undefined);

  await DBOS.runStep(() => deps.api.completeBroadcast(input.broadcastId), {
    name: 'complete',
    ...RETRY_THE_API,
  });
}

/**
 * One recipient's whole send — the audience
 * check, the link, the email and the record of
 * what happened — in a single step.
 *
 * The step is deliberately not retried. It sends
 * an email and then records that it sent one, so
 * a retry after a send SendGrid already accepted
 * would deliver a second copy. A crash in that
 * same window has the same effect on resume: one
 * recipient may get one progress email twice.
 * That is accepted. Closing the window would take
 * a provider-side idempotency key SendGrid does
 * not offer, and a duplicated progress note is a
 * far smaller harm than a broadcast that stalls.
 * Retrying here would widen a window that is
 * meant to stay as narrow as a crash.
 */
async function sendToRecipient(
  deps: WorkerDeps,
  broadcast: InternalBroadcastResponse,
  row: InternalRecipient,
): Promise<void> {
  const outcome = await attemptSend(deps, broadcast, row);

  // The flip reports the status the row actually
  // holds, which is the one recorded first. If
  // another run got there already, that answer
  // stands and this one keeps going.
  await deps.api.flipDelivery(broadcast.id, {
    subscriberId: row.subscriberId,
    ...outcome,
  });
}

/**
 * A terminal failure is recorded rather than
 * thrown: one bad address must not strand the
 * rest of the audience, and the admin sees it on
 * the delivery row either way.
 */
async function attemptSend(
  deps: WorkerDeps,
  broadcast: InternalBroadcastResponse,
  row: InternalRecipient,
): Promise<Omit<DeliveryFlipRequest, 'subscriberId'>> {
  // Their status right now, not the one they were
  // in when the broadcast was composed. Someone
  // who bounced and signed up again is subscribed
  // and gets the email; someone who unsubscribed
  // mid-broadcast does not.
  if (!broadcast.audience.includes(row.currentStatus)) {
    return { status: 'skipped' };
  }

  try {
    const token = mintManageToken(deps.keyRing, {
      subscriberId: row.subscriberId,
      tokenVersion: row.tokenVersion,
      now: deps.now(),
    });

    await deps.mailer.send(
      renderBroadcastEmail({
        to: row.email,
        subject: broadcast.subject,
        bodyMarkdown: broadcast.bodyMarkdown,
        teaserImageUrl: broadcast.teaserImageUrl,
        links: {
          manageUrl: manageUrl(deps.siteUrl, token),
          unsubscribeUrl: unsubscribeUrl(deps.siteUrl, token),
        },
      }),
    );

    return { status: 'sent' };
  } catch (error) {
    // The provider's own text, cut to what the
    // delivery row takes — a rejected flip would
    // lose the record of the failure as well as
    // the send.
    return { status: 'failed', error: String(error).slice(0, MAX_ERROR) };
  }
}
