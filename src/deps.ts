import { parseKeyRing } from '@mboss/core/signed-links';
import type { LinkKeyRing } from '@mboss/core/signed-links';

import { createInternalApi } from './api/internal-client.js';
import type { InternalApi } from './api/internal-client.js';
import { createTwilioEmailMailer } from './email/mailer.js';
import type { Mailer } from './email/mailer.js';
import type { Env } from './env.js';

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
  keyRing: LinkKeyRing;
  siteUrl: string;
  now: () => Date;
};

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
    keyRing: parseKeyRing(env.LINK_KEYS),
    siteUrl: env.SITE_URL,
    now: () => new Date(),
  };
}
