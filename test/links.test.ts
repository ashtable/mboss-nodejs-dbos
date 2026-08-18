import { parseKeyRing, verifyLink } from '@mboss/core/signed-links';
import { describe, expect, it } from 'vitest';

import { manageUrl, mintManageToken, unsubscribeUrl } from '../src/links.js';
import { FIXED_NOW, TEST_LINK_KEYS } from './helpers/fixtures.js';

describe('link URLs', () => {
  it('builds the manage URL the API verifies', () => {
    expect(manageUrl('https://mboss.dev', 'tok-1')).toBe(
      'https://mboss.dev/u/tok-1',
    );
  });

  it('builds the one-click unsubscribe URL', () => {
    expect(unsubscribeUrl('https://mboss.dev', 'tok-1')).toBe(
      'https://mboss.dev/api/unsubscribe/tok-1',
    );
  });
});

describe('mintManageToken', () => {
  const ring = parseKeyRing(TEST_LINK_KEYS);
  const token = mintManageToken(ring, {
    subscriberId: 'sub_1',
    tokenVersion: 3,
    now: FIXED_NOW,
  });

  it('mints a token the ring can verify', () => {
    expect(verifyLink(ring, token, 'wl.manage').ok).toBe(true);
  });

  it('carries the subscriber and its token version', () => {
    const result = verifyLink(ring, token, 'wl.manage');

    expect(result.ok && result.payload).toMatchObject({
      t: 'wl.manage',
      sub: 'sub_1',
      tv: 3,
    });
  });

  it('floors the issued-at to whole seconds', () => {
    // The minter refuses a fractional claim
    // rather than producing a token nothing can
    // verify, and the fixed clock has
    // milliseconds on it.
    const result = verifyLink(ring, token, 'wl.manage');

    expect(result.ok && result.payload.iat).toBe(
      Math.floor(FIXED_NOW.getTime() / 1000),
    );
  });
});
