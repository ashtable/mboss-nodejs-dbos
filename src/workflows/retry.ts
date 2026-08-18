import { isRetryableApiError } from '../api/internal-client.js';

/**
 * `retriesAllowed` is off unless a step says
 * otherwise, so leaving it unset is a decision
 * rather than the absence of one. Every step in
 * this worker states its policy, and the two
 * policies below are the only ones there are.
 */

/**
 * A call into the internal API. Worth retrying
 * when the answer was a server error or when
 * there was no answer at all; not worth retrying
 * a 4xx, which will say the same thing next time.
 *
 * Eight attempts at a doubling interval is about
 * two minutes, and two minutes is the number that
 * matters: the only service these steps talk to
 * is the API deployed beside this worker, and it
 * is away for tens of seconds every time it
 * ships. Three attempts covered about three
 * seconds, so a release killed whatever was
 * running, and a confirmation that dies that way
 * has no way back — the same id is derived on
 * every later signup and attaches to the corpse.
 * Longer than eight is worse rather than better:
 * one queue slot serves every email, so the
 * budget is also how long a failing step can hold
 * it. The sends keep three, written where they
 * are used, and keep it for a different reason —
 * a message the provider refuses twice will be
 * refused a third time.
 */
export const RETRY_THE_API = {
  retriesAllowed: true,
  maxAttempts: 8,
  intervalSeconds: 1,
  backoffRate: 2,
  shouldRetry: isRetryableApiError,
} as const;
