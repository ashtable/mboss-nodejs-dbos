import { parseKeyRing } from '@mboss/core/signed-links';

import type { SenderDeps, WorkerDeps } from '../../src/deps.js';
import { FakeBounceScan } from '../fakes/fake-bounce-scan.js';
import { FakeDeliveryStatus } from '../fakes/fake-delivery-status.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { FIXED_NOW, TEST_LINK_KEYS } from './fixtures.js';

type Parts = {
  api?: FakeInternalApi;
  mailer?: FakeMailer;
  deliveryStatus?: FakeDeliveryStatus;
};

/**
 * The worker's dependencies with the three
 * collaborators it reaches over the network
 * replaced, and a clock that does not move. Both
 * suites use this; only the integration one lets
 * DBOS itself be real.
 *
 * The scan schedule is the shipped default rather
 * than a shrunk one: nothing sleeps for real here,
 * and a test that asserts on the sleeps wants the
 * numbers the worker actually runs with.
 */
export function testDeps(parts: Parts = {}): WorkerDeps {
  return {
    api: parts.api ?? new FakeInternalApi(),
    mailer: parts.mailer ?? new FakeMailer(),
    deliveryStatus: parts.deliveryStatus ?? new FakeDeliveryStatus(),
    bounceScanDelays: [3600, 172800],
    keyRing: parseKeyRing(TEST_LINK_KEYS),
    siteUrl: 'https://mboss.dev',
    now: () => FIXED_NOW,
  };
}

/**
 * The same, for the two workflows that can start a
 * bounce scan. Pass a `FakeBounceScan` to read
 * back what they asked for.
 */
export function testSenderDeps(
  parts: Parts & { bounceScan?: FakeBounceScan } = {},
): SenderDeps {
  return {
    ...testDeps(parts),
    startBounceScan: (parts.bounceScan ?? new FakeBounceScan()).start,
  };
}
