import { describe, expect, it } from 'vitest';

import { readEnv } from '../src/env.js';

const complete = {
  DATABASE_URL: 'postgres://postgres:mboss@localhost:5432/mboss',
  API_BASE_URL: 'http://localhost:3001',
  INTERNAL_API_TOKEN: 'dev-internal-api-token',
  LINK_KEYS: `k1:${'a'.repeat(64)}`,
  TWILIO_API_KEY: 'SK_test',
  TWILIO_API_SECRET: 'secret_test',
};

function messageThrownBy(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected readEnv to throw');
}

describe('readEnv', () => {
  it('names every missing variable at once', () => {
    const message = messageThrownBy(() => readEnv({}));

    for (const name of Object.keys(complete)) {
      expect(message).toContain(name);
    }
  });

  it('defaults the DBOS system database to the application database', () => {
    expect(readEnv(complete).DBOS_SYSTEM_DATABASE_URL).toBe(
      complete.DATABASE_URL,
    );
  });

  it('lets an explicit DBOS system database win', () => {
    const elsewhere = 'postgres://postgres:mboss@localhost:5432/other';

    expect(
      readEnv({ ...complete, DBOS_SYSTEM_DATABASE_URL: elsewhere })
        .DBOS_SYSTEM_DATABASE_URL,
    ).toBe(elsewhere);
  });

  it('defaults the mail API, the sender and the site URL', () => {
    const env = readEnv(complete);

    // Left alone, the worker talks to the real
    // provider. A local run points this at a mail
    // sink instead.
    expect(env.TWILIO_EMAIL_BASE_URL).toBe('https://comms.twilio.com');
    expect(env.MAIL_FROM).toBe('hello@mboss.dev');
    expect(env.SITE_URL).toBe('https://mboss.dev');
  });

  it('defaults the bounce scan to an hour and then two days', () => {
    // Offsets from the moment the scan is
    // enqueued, not gaps between its passes.
    expect(readEnv(complete).BOUNCE_SCAN_DELAYS_S).toEqual([3600, 172800]);
  });

  it('reads an explicit bounce scan schedule', () => {
    // Which is how a test or a local run shrinks
    // the schedule without touching a clock.
    expect(
      readEnv({ ...complete, BOUNCE_SCAN_DELAYS_S: '5,10' })
        .BOUNCE_SCAN_DELAYS_S,
    ).toEqual([5, 10]);
  });

  it.each(['abc', '0', '-1', '1.5', ''])(
    'rejects %o as a bounce scan schedule',
    (delays) => {
      expect(() =>
        readEnv({ ...complete, BOUNCE_SCAN_DELAYS_S: delays }),
      ).toThrow('BOUNCE_SCAN_DELAYS_S');
    },
  );

  it('rejects a bounce scan schedule that goes backwards', () => {
    // The workflow sleeps the difference between
    // one offset and the last, so a descending
    // list asks it to sleep a negative number of
    // seconds.
    expect(() =>
      readEnv({ ...complete, BOUNCE_SCAN_DELAYS_S: '172800,3600' }),
    ).toThrow('BOUNCE_SCAN_DELAYS_S');
  });

  it('strips a trailing slash from the site and API base URLs', () => {
    const env = readEnv({
      ...complete,
      API_BASE_URL: 'http://localhost:3001/',
      SITE_URL: 'https://mboss.dev/',
    });

    expect(env.API_BASE_URL).toBe('http://localhost:3001');
    expect(env.SITE_URL).toBe('https://mboss.dev');
  });
});
