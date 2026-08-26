import type { EmailMessage } from '@mboss/core/email';
import { z } from 'zod';

/**
 * The one place in the project that talks to
 * Twilio Email, behind an interface small enough
 * that every test can hand the workflows a
 * recording double instead.
 */
export interface Mailer {
  send(message: EmailMessage): Promise<SendReceipt>;
}

/**
 * What the provider hands back for an accepted
 * send. Acceptance is not delivery — the message
 * is queued, and `operationId` is the only handle
 * anything has on where it ends up.
 */
export type SendReceipt = {
  operationId: string;
  operationLocation: string;
};

export type MailerConfig = {
  /**
   * An API key pair rather than the account
   * credentials, so this worker's access can be
   * revoked on its own without locking every
   * other consumer out of the account.
   */
  apiKey: string;
  apiSecret: string;
  /** The API root, without the version segment. */
  baseUrl: string;
  from: string;
};

/**
 * A send the provider refused. `code` is the HTTP
 * status, named to match what
 * `isTransientSendFailure` reads; `message` is the
 * provider's own wording, kept because a failed
 * broadcast send writes it onto the delivery row
 * an admin reads.
 */
export class MailSendError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

/**
 * The accepted-send body is parsed rather than
 * trusted, so a drift between the provider's shape
 * and ours surfaces at the send — not as an
 * undefined operation id inside a bounce scan two
 * days later.
 */
const SendAcceptedSchema = z.object({
  operationId: z.string().min(1),
  operationLocation: z.string().min(1),
});

/**
 * `fetchImpl` is an ordinary dependency with a
 * production default, not a test hatch: the tests
 * hand in a transport that records instead of
 * opening a socket.
 */
export function createTwilioEmailMailer(
  config: MailerConfig,
  fetchImpl?: typeof globalThis.fetch,
): Mailer {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const credentials = Buffer.from(
    `${config.apiKey}:${config.apiSecret}`,
  ).toString('base64');

  return {
    async send(message: EmailMessage): Promise<SendReceipt> {
      const response = await doFetch(`${config.baseUrl}/v1/Emails`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: { address: config.from, name: 'mBoss' },
          to: [{ address: message.to }],
          // No `text`: the provider derives the
          // plain-text part from the HTML, and
          // generating our own would be a second
          // rendering of every template to keep in
          // step with the first.
          content: {
            subject: message.subject,
            html: message.html,
            ...(message.headers === undefined
              ? {}
              : { headers: message.headers }),
          },
        }),
      });

      const payload: unknown = await response.json().catch(() => undefined);
      // Anything but a 202 is a refusal. The API
      // answers an accepted send with that status
      // and nothing else.
      if (response.status !== 202)
        throw new MailSendError(
          response.status,
          refusalMessage(payload, response.status),
        );

      return SendAcceptedSchema.parse(payload);
    },
  };
}

/**
 * Whether a refused send is worth another try.
 *
 * `MailSendError` carries the HTTP status as
 * `code`. A rate limit or a provider-side failure
 * will likely pass on the next attempt; anything
 * else in the 4xx range is a complaint about the
 * message itself, and resending it unchanged only
 * delays the failure. A throw with no status at
 * all never reached the provider, which is the
 * transient case retries exist for.
 */
export function isTransientSendFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return true;

  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'number') return true;

  return code === 429 || code >= 500;
}

/**
 * The provider's own wording for a refusal, or the
 * bare status when it offered none. Shared with the
 * status reader: one provider, one way of reading
 * what it said no with.
 */
export function refusalMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const shape = payload as { message?: unknown };
    if (typeof shape.message === 'string') return shape.message;
  }
  return `HTTP ${status}`;
}
