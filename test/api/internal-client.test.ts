import { describe, expect, it } from 'vitest';

import {
  InternalApiError,
  createInternalApi,
  isRetryableApiError,
} from '../../src/api/internal-client.js';
import type { InternalApi } from '../../src/api/internal-client.js';
import { BROADCAST, SUBSCRIBER } from '../helpers/fixtures.js';

const BASE_URL = 'http://api.test';
const TOKEN = 'dev-internal-api-token';

type Recorded = {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string | undefined;
};

/**
 * Every route answers 200 with a body of the
 * right shape unless a test says otherwise, so a
 * test that cares about one route does not have
 * to describe the other five.
 */
function bodyFor(url: string): unknown {
  if (url.endsWith('/confirmation-sent'))
    return { confirmationEmailSentAt: '2026-08-16T12:00:00.000Z' };
  if (url.includes('/recipients')) return { rows: [] };
  if (url.endsWith('/deliveries')) return { status: 'sent' };
  if (url.endsWith('/complete'))
    return { status: 'sent', sentCount: 1, failedCount: 0, skippedCount: 0 };
  if (url.includes('/broadcasts/')) return BROADCAST;
  return SUBSCRIBER;
}

function stub(
  respond: (url: string) => { status: number; body: unknown } = (url) => ({
    status: 200,
    body: bodyFor(url),
  }),
): { calls: Recorded[]; api: InternalApi } {
  const calls: Recorded[] = [];

  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      authorization:
        new Headers(init?.headers).get('authorization') ?? undefined,
    });
    const { status, body } = respond(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    calls,
    api: createInternalApi({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetch: fetchStub,
    }),
  };
}

const everyCall: [string, (api: InternalApi) => Promise<unknown>, string][] = [
  [
    'getSubscriber',
    (api) => api.getSubscriber('sub_1'),
    'http://api.test/internal/v1/subscribers/sub_1',
  ],
  [
    'recordConfirmationSent',
    (api) => api.recordConfirmationSent('sub_1'),
    'http://api.test/internal/v1/subscribers/sub_1/confirmation-sent',
  ],
  [
    'getBroadcast',
    (api) => api.getBroadcast('bc_1'),
    'http://api.test/internal/v1/broadcasts/bc_1',
  ],
  [
    'listRecipients',
    (api) => api.listRecipients('bc_1', 'cur-1'),
    'http://api.test/internal/v1/broadcasts/bc_1/recipients?cursor=cur-1',
  ],
  [
    'flipDelivery',
    (api) =>
      api.flipDelivery('bc_1', { subscriberId: 'sub_1', status: 'sent' }),
    'http://api.test/internal/v1/broadcasts/bc_1/deliveries',
  ],
  [
    'completeBroadcast',
    (api) => api.completeBroadcast('bc_1'),
    'http://api.test/internal/v1/broadcasts/bc_1/complete',
  ],
];

describe('the internal API client', () => {
  it.each(everyCall)(
    'sends the internal token as a bearer on %s',
    async (_name, call) => {
      const { calls, api } = stub();

      await call(api);

      expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    },
  );

  it.each(everyCall)('builds the URL for %s', async (_name, call, url) => {
    const { calls, api } = stub();

    await call(api);

    expect(calls[0]?.url).toBe(url);
  });

  it('omits the cursor on the first page of recipients', async () => {
    const { calls, api } = stub();

    await api.listRecipients('bc_1', undefined);

    expect(calls[0]?.url).toBe(
      'http://api.test/internal/v1/broadcasts/bc_1/recipients',
    );
  });

  it('posts an empty body where the route takes its arguments from the path', async () => {
    const { calls, api } = stub();

    await api.recordConfirmationSent('sub_1');
    await api.completeBroadcast('bc_1');

    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ['POST', '{}'],
      ['POST', '{}'],
    ]);
  });

  it('sends the delivery flip as its wire body', async () => {
    const { calls, api } = stub();

    await api.flipDelivery('bc_1', {
      subscriberId: 'sub_1',
      status: 'failed',
      error: 'nope',
    });

    expect(calls[0]?.body).toBe(
      '{"subscriberId":"sub_1","status":"failed","error":"nope"}',
    );
  });

  it('validates responses against the shared schemas', async () => {
    const drifted: Record<string, unknown> = { ...SUBSCRIBER };
    delete drifted['tokenVersion'];
    const { api } = stub(() => ({ status: 200, body: drifted }));

    // A 200 whose body has drifted is a failure,
    // not an `undefined` three frames later.
    await expect(api.getSubscriber('sub_1')).rejects.toThrow();
  });

  it('turns a non-200 into an error carrying the status', async () => {
    const { api } = stub(() => ({
      status: 400,
      body: {
        error: 'Bad Request',
        statusCode: 400,
        message: 'cursor is not a cursor this API minted',
      },
    }));

    await expect(api.listRecipients('bc_1', 'bogus')).rejects.toMatchObject({
      status: 400,
      // Preserved because it ends up on the
      // delivery row an admin reads.
      message: 'cursor is not a cursor this API minted',
    });
  });

  it('reports a 404 for an unknown subscriber', async () => {
    const { api } = stub(() => ({
      status: 404,
      body: { error: 'Not Found', statusCode: 404 },
    }));

    await expect(api.getSubscriber('nobody')).rejects.toMatchObject({
      status: 404,
      message: 'Not Found',
    });
  });
});

describe('isRetryableApiError', () => {
  it('retries a server error', () => {
    expect(isRetryableApiError(new InternalApiError(503, 'nope'))).toBe(true);
  });

  it('does not retry a client error', () => {
    // A 404 for a subscriber id will be a 404
    // next time too.
    expect(isRetryableApiError(new InternalApiError(404, 'Not Found'))).toBe(
      false,
    );
  });

  it('retries anything that never reached the API', () => {
    // This is how `fetch` reports a network
    // failure, and a network failure is the
    // transient case retries exist for.
    expect(isRetryableApiError(new TypeError('fetch failed'))).toBe(true);
  });
});
