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
 */
export const RETRY_THE_API = {
  retriesAllowed: true,
  maxAttempts: 3,
  intervalSeconds: 1,
  backoffRate: 2,
  shouldRetry: isRetryableApiError,
} as const;
