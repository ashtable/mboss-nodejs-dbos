import { describe, expect, it } from 'vitest';

import {
  listUnsubscribeHeaders,
  manageUrl,
  unsubscribeUrl,
} from '../src/links.js';

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

describe('listUnsubscribeHeaders', () => {
  it('spells out both RFC 8058 headers', () => {
    expect(
      listUnsubscribeHeaders('https://mboss.dev/api/unsubscribe/tok-1'),
    ).toEqual({
      'List-Unsubscribe':
        '<https://mboss.dev/api/unsubscribe/tok-1>, ' +
        '<mailto:unsubscribe@mboss.dev>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});
