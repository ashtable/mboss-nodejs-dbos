import { parseKeyRing } from '@mboss/core/signed-links';

import type { WorkerDeps } from '../../src/deps.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { FIXED_NOW, TEST_LINK_KEYS } from './fixtures.js';

/**
 * The worker's dependencies with the two
 * collaborators it reaches over the network
 * replaced, and a clock that does not move. Both
 * suites use this; only the integration one lets
 * DBOS itself be real.
 */
export function testDeps(
  parts: { api?: FakeInternalApi; mailer?: FakeMailer } = {},
): WorkerDeps {
  return {
    api: parts.api ?? new FakeInternalApi(),
    mailer: parts.mailer ?? new FakeMailer(),
    keyRing: parseKeyRing(TEST_LINK_KEYS),
    siteUrl: 'https://mboss.dev',
    now: () => FIXED_NOW,
  };
}
