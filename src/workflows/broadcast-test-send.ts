import { DBOS } from '@dbos-inc/dbos-sdk';
import { TestSendRequestSchema } from '@mboss/zod';

import type { WorkerDeps } from '../deps.js';
import { renderBroadcastEmail } from '../email/broadcast.js';

/**
 * Puts a draft broadcast in front of the person
 * writing it.
 *
 * It reaches none of the broadcast routes: there
 * is no broadcast row, no audience and no
 * delivery to record. It also carries no manage
 * link and no one-click unsubscribe headers,
 * because there is no subscriber behind the
 * address — a token minted against nobody could
 * never verify, and a permanently dead
 * unsubscribe link in a real inbox is worse than
 * a footer that says the word in plain text.
 *
 * The step is not retried and nothing is caught.
 * An admin who presses "send test" and gets
 * nothing should see the failure, not a workflow
 * that quietly succeeded.
 */
export async function broadcastTestSend(
  deps: WorkerDeps,
  input: unknown,
): Promise<void> {
  // Parsing is pure, so it is safe in the
  // workflow body — and doing it here means a
  // malformed enqueue fails before it has sent
  // anything.
  const request = TestSendRequestSchema.parse(input);

  await DBOS.runStep(
    () =>
      deps.mailer.send(
        renderBroadcastEmail({
          to: request.to,
          subject: request.subject,
          bodyMarkdown: request.bodyMarkdown,
          teaserImageUrl: request.teaserImageUrl ?? null,
          links: null,
        }),
      ),
    { name: 'test-send', retriesAllowed: false },
  );
}
