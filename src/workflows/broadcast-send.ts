import { DBOS } from '@dbos-inc/dbos-sdk';
import { renderBroadcastEmail } from '@mboss/core/email';
import type {
  DeliveryFlipRequest,
  InternalBroadcastResponse,
  InternalRecipient,
} from '@mboss/zod';

import type { SenderDeps, WorkerDeps } from '../deps.js';
import { manageUrl, mintManageToken, unsubscribeUrl } from '../links.js';
import type { BounceScanInput } from './bounce-scan.js';
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
 *
 * A run that stops early stops loudly: the rows
 * it never reached stay pending and the broadcast
 * stays sending, which is a state someone has to
 * clear, and can.
 */
export async function broadcastSend(
  deps: SenderDeps,
  input: BroadcastSendInput,
): Promise<void> {
  const broadcast = await DBOS.runStep(
    () => deps.api.getBroadcast(input.broadcastId),
    { name: 'fetch-broadcast', ...RETRY_THE_API },
  );

  let cursor: string | undefined;
  let page = 0;
  const accepted: BounceScanInput['sends'] = [];

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

      // Only a send the provider took has anything
      // to poll for. Building the list here rather
      // than re-deriving it later keeps it to the
      // rows this run actually mailed, and the
      // step's outcome is checkpointed, so a
      // resume rebuilds the same list.
      if (outcome.operationId !== undefined) {
        accepted.push({
          email: row.email,
          operationId: outcome.operationId,
        });
      }

      // A flip the API will not take at all ends
      // the run, and that is the decision rather
      // than an oversight. A row that has already
      // settled comes back with the status it
      // holds, so a refusal means the delivery row
      // is not there or the body describing it is
      // not one the API takes — neither of which
      // is about this recipient, and both of which
      // meet every recipient after them. The same
      // is true once the attempts are spent: the
      // API has been unreachable for minutes.
      // Carrying on would mail the rest of the
      // audience and record none of it, and
      // completion counts a row it never saw
      // flipped as handled — so the broadcast
      // would be marked sent with nobody able to
      // say who was written to, and a completion
      // cannot be taken back. Stopping leaves
      // every unflipped row pending, which is what
      // the recipient list is derived from, so the
      // run can be picked up from this step and
      // carry on from exactly here, with the sends
      // it already recorded replayed rather than
      // repeated.
      await DBOS.runStep(
        () =>
          deps.api.flipDelivery(broadcast.id, {
            subscriberId: row.subscriberId,
            ...outcome.flip,
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

  // One scan for the whole broadcast, asked for
  // last and from the workflow body — DBOS will
  // not start a workflow from inside a step, and a
  // run that stopped early never reaches here, so
  // the scan covers exactly what was mailed.
  if (accepted.length > 0) await deps.startBounceScan({ sends: accepted });
}

/**
 * What one attempt produced: the outcome to record
 * on the delivery row, and — when the provider
 * took the message — the operation to poll for a
 * bounce later.
 *
 * The operation id stays out of the flip body on
 * purpose. The API's schema does not carry one,
 * and smuggling an extra key through a validated
 * wire body is how a silent strip or a 400 turns
 * up much later.
 */
type SendOutcome = {
  flip: Omit<DeliveryFlipRequest, 'subscriberId'>;
  operationId?: string;
};

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
 * provider-side idempotency key Twilio Email does
 * not offer. One duplicated progress note is a far
 * smaller harm than a broadcast that stalls.
 */
async function attemptSend(
  deps: WorkerDeps,
  broadcast: InternalBroadcastResponse,
  row: InternalRecipient,
): Promise<SendOutcome> {
  // Their status right now, not the one they were
  // in when the broadcast was composed. Someone
  // who bounced and signed up again is subscribed
  // and gets the email; someone who unsubscribed
  // mid-broadcast does not.
  if (!broadcast.audience.includes(row.currentStatus)) {
    return { flip: { status: 'skipped' } };
  }

  try {
    const token = mintManageToken(deps.keyRing, {
      subscriberId: row.subscriberId,
      tokenVersion: row.tokenVersion,
      now: deps.now(),
    });

    const receipt = await deps.mailer.send(
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

    return { flip: { status: 'sent' }, operationId: receipt.operationId };
  } catch (error) {
    // The provider's own text, cut to what the
    // delivery row takes — a rejected flip would
    // lose the record of the failure as well as
    // the send.
    return {
      flip: { status: 'failed', error: String(error).slice(0, MAX_ERROR) },
    };
  }
}
