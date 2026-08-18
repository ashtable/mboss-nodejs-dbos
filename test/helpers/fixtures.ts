import type {
  InternalBroadcastResponse,
  InternalSubscriberResponse,
} from '@mboss/zod';

/**
 * The same seeded subscriber and broadcast the
 * API's own tests use, so a failure here reads
 * against the same ids on both sides of the wire.
 */

export const SUBSCRIBER: InternalSubscriberResponse = {
  id: 'sub_1',
  email: 'pat@stmarks.org',
  status: 'subscribed',
  tokenVersion: 1,
  confirmationEmailSentAt: null,
  createdAt: '2026-08-16T00:00:00.000Z',
};

export const BROADCAST: InternalBroadcastResponse = {
  id: 'bc_1',
  subject: 'Progress update #3 — the canvas is alive',
  bodyMarkdown: '# The canvas is alive.\n\nFirst look at the mBoss canvas.',
  audience: ['subscribed'],
  teaserImageUrl: null,
  status: 'sending',
  recipientCount: 2,
  createdAt: '2026-08-16T00:00:00.000Z',
};

/** A ring the tests can both mint and verify with. */
export const TEST_LINK_KEYS = `k1:${'a'.repeat(64)}`;

/**
 * A fixed clock, so a minted token is the same
 * string on every run and a test can assert on
 * the link it lands in.
 */
export const FIXED_NOW = new Date('2026-08-16T12:00:00.500Z');
