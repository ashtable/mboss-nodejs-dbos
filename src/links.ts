import { mintLink } from '@mboss/core/signed-links';
import type { LinkKeyRing } from '@mboss/core/signed-links';

/**
 * The two URLs a signed manage token appears in,
 * and the headers that carry the second one.
 *
 * `mintLink` returns a bare token, never a URL —
 * the module that signs has no business knowing
 * where the site lives. Assembling the URL is
 * this worker's job, and `readEnv` has already
 * taken the trailing slash off `SITE_URL` so
 * these can concatenate plainly.
 */

/** The manage page: pause, resume or unsubscribe. */
export function manageUrl(siteUrl: string, token: string): string {
  return `${siteUrl}/u/${token}`;
}

/**
 * One-click unsubscribe. Distinct from the manage
 * page because a mail client posts to it
 * unattended, with nobody there to choose.
 */
export function unsubscribeUrl(siteUrl: string, token: string): string {
  return `${siteUrl}/api/unsubscribe/${token}`;
}

/**
 * The one-click unsubscribe pair a bulk send
 * carries. `List-Unsubscribe-Post` is the exact
 * literal the RFC defines and admits no variation;
 * the mailbox address beside the URL is a fixed
 * fallback for clients that only understand
 * `mailto:`.
 */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>, <mailto:unsubscribe@mboss.dev>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * The token behind both URLs. A manage link never
 * expires — it is revoked by bumping the
 * subscriber's token version — so the version
 * here is the one read at send time, not a
 * remembered one.
 *
 * Call this inside a step. The clock reading
 * makes it non-deterministic, and a workflow body
 * that mints would mint a different token on
 * every replay.
 */
export function mintManageToken(
  ring: LinkKeyRing,
  input: { subscriberId: string; tokenVersion: number; now: Date },
): string {
  return mintLink(ring, {
    t: 'wl.manage',
    sub: input.subscriberId,
    tv: input.tokenVersion,
    // Whole seconds: the minter rejects a
    // fractional claim rather than producing a
    // token nothing can verify.
    iat: Math.floor(input.now.getTime() / 1000),
  });
}
