import { parseKeyRing } from '@mboss/core/signed-links';
import type { LinkKeyRing } from '@mboss/core/signed-links';

import { createInternalApi } from './api/internal-client.js';
import type { InternalApi } from './api/internal-client.js';
import { createTwilioEmailStatus } from './email/delivery-status.js';
import type { DeliveryStatusReader } from './email/delivery-status.js';
import { createTwilioEmailMailer } from './email/mailer.js';
import type { Mailer } from './email/mailer.js';
import type { Env } from './env.js';
import type { StartBounceScan } from './workflows/bounce-scan.js';

/**
 * Everything the workflows reach outside
 * themselves. Both suites hand them the same two
 * doubles for the API and the mailer; only the
 * integration suite lets DBOS itself be real.
 *
 * `now` is a dependency rather than a call to
 * `Date.now()` because the manage token is minted
 * from it: a fixed clock is what lets a test
 * assert on the exact link that landed in the
 * email.
 */
export type WorkerDeps = {
  api: InternalApi;
  mailer: Mailer;
  deliveryStatus: DeliveryStatusReader;
  bounceScanDelays: number[];
  keyRing: LinkKeyRing;
  siteUrl: string;
  now: () => Date;
};

/**
 * The senders' extra dependency. It cannot be
 * built here: only a registered workflow can be
 * started, and registration happens later.
 *
 * A workflow that takes plain `WorkerDeps` cannot
 * see `startBounceScan` and so cannot enqueue a
 * scan. That is the point — a test send has no
 * subscriber and no delivery row, so a bounce it
 * found would have nothing to act on, and the type
 * is what says so.
 */
export type SenderDeps = WorkerDeps & { startBounceScan: StartBounceScan };

export function buildDeps(env: Env): WorkerDeps {
  return {
    api: createInternalApi({
      baseUrl: env.API_BASE_URL,
      token: env.INTERNAL_API_TOKEN,
    }),
    mailer: createTwilioEmailMailer({
      apiKey: env.TWILIO_API_KEY,
      apiSecret: env.TWILIO_API_SECRET,
      baseUrl: env.TWILIO_EMAIL_BASE_URL,
      from: env.MAIL_FROM,
    }),
    deliveryStatus: createTwilioEmailStatus({
      apiKey: env.TWILIO_API_KEY,
      apiSecret: env.TWILIO_API_SECRET,
      baseUrl: env.TWILIO_EMAIL_BASE_URL,
    }),
    bounceScanDelays: env.BOUNCE_SCAN_DELAYS_S,
    keyRing: parseKeyRing(env.LINK_KEYS),
    siteUrl: env.SITE_URL,
    now: () => new Date(),
  };
}
