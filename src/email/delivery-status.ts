import { z } from 'zod';

import { MailSendError, refusalMessage } from './mailer.js';

/** Where one accepted send got to. */
export type DeliveryState = 'pending' | 'settled' | 'bounced';

/**
 * Reads what became of a send the provider
 * accepted. There is no webhook, so this poll is
 * the only way a bounce is ever heard about.
 */
export interface DeliveryStatusReader {
  read(operationId: string): Promise<DeliveryState>;
}

export type DeliveryStatusConfig = {
  apiKey: string;
  apiSecret: string;
  /** The API root, without the version segment. */
  baseUrl: string;
};

/**
 * `status` stays a plain string rather than an
 * enum of the states known today. A state the
 * provider adds later has to read as "not settled
 * yet", not fail the parse and kill a scan two
 * days into its schedule.
 */
const EmailListSchema = z.object({
  emails: z.array(z.object({ status: z.string() })),
});

/**
 * A message that came back is the one thing worth
 * acting on; a message that was never delivered
 * and never will be leaves nobody to suppress.
 */
const BOUNCED = new Set(['UNDELIVERED', 'FAILED']);
const SETTLED = new Set(['DELIVERED', 'OPENED', 'CANCELED']);

/**
 * The provider's nine states collapsed to the
 * three the scan acts on: post the bounce, stop
 * asking, or ask again.
 *
 * `SENT` is not settled. The provider has handed
 * the message to the receiving side and a bounce
 * can still come back from there, which is the
 * whole reason the second pass exists.
 */
function stateOf(providerStatus: string): DeliveryState {
  if (BOUNCED.has(providerStatus)) return 'bounced';
  if (SETTLED.has(providerStatus)) return 'settled';
  return 'pending';
}

/**
 * Reads the email the operation sent rather than
 * the operation's own aggregate counts. The
 * provider documents a per-message status and
 * documents filtering emails by operation; it does
 * not say whether those counts keep moving once
 * the operation reports itself complete, and a
 * bounce arrives long after that. Every mBoss send
 * goes to one address, so one page is the whole
 * answer.
 */
export function createTwilioEmailStatus(
  config: DeliveryStatusConfig,
  fetchImpl?: typeof globalThis.fetch,
): DeliveryStatusReader {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const credentials = Buffer.from(
    `${config.apiKey}:${config.apiSecret}`,
  ).toString('base64');

  return {
    async read(operationId: string): Promise<DeliveryState> {
      const response = await doFetch(
        `${config.baseUrl}/v1/Emails` +
          `?operationId=${encodeURIComponent(operationId)}&pageSize=1`,
        { headers: { authorization: `Basic ${credentials}` } },
      );

      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok)
        throw new MailSendError(
          response.status,
          refusalMessage(payload, response.status),
        );

      const [email] = EmailListSchema.parse(payload).emails;
      // An hour after a send was accepted the row
      // may not exist yet. Nothing to report is
      // not a failure — the next pass asks again.
      return email === undefined ? 'pending' : stateOf(email.status);
    },
  };
}
