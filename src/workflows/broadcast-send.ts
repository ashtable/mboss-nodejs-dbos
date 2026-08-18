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
 * The recipient set is not held here, and the two
 * ways a run starts over are protected by
 * different things. A re-enqueue under a new
 * workflow id re-derives the set from the API,
 * which returns only rows still pending, so
 * nothing already settled is sent again. A crash
 * and resume under the same id does not re-page at
 * all: DBOS replays the checkpointed pages, and
 * the per-recipient steps that already ran.
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
      // Two steps, not one. The send must not be
      // retried, because a second attempt after
      // the provider accepted the first delivers a
      // second copy. The flip must be: it is a
      // conditional update that reports whatever
      // status was recorded first, so repeating it
      // is a no-op, while leaving it un-retried
      // lets one blip on one recipient strand
      // everyone after them.
      const outcome = await DBOS.runStep(
        () => attemptSend(deps, broadcast, row),
        { name: `send:${row.subscriberId}`, retriesAllowed: false },
      );

      await DBOS.runStep(
        () =>
          deps.api.flipDelivery(broadcast.id, {
            subscriberId: row.subscriberId,
            ...outcome,
          }),
        { name: `flip:${row.subscriberId}`, ...RETRY_THE_API },
      );
    }

    cursor = recipients.nextCursor;
  } while (cursor !== undefined);

  await DBOS.runStep(() => deps.api.completeBroadcast(input.broadcastId), {
    name: 'complete',
    ...RETRY_THE_API,
  });
}

/**
 * One recipient's send — the audience check, the
 * link, the email — and the outcome to record for
 * it. A terminal failure comes back as that
 * outcome rather than being thrown: one bad
 * address must not strand the rest of the
 * audience, and the admin sees it on the delivery
 * row either way.
 *
 * The step this runs in is deliberately not
 * retried, so one duplicate-send window is
 * accepted: a crash between the provider taking
 * the message and this outcome being checkpointed
 * means the recipient is mailed again on resume.
 * That window is as narrow as a crash — returning
 * the outcome is the next thing that happens —
 * and closing it entirely would take a
 * provider-side idempotency key SendGrid does not
 * offer. One duplicated progress note is a far
 * smaller harm than a broadcast that stalls.
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
