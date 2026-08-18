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
