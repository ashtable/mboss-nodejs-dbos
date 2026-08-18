import type { Client } from '@sendgrid/client';
import type { ClientRequest } from '@sendgrid/client/src/request';
import type { ClientResponse } from '@sendgrid/client/src/response';
import { beforeEach, describe, expect, it } from 'vitest';

import { readEnv } from '../../src/env.js';
import {
  buildSendGridClient,
  createSendGridMailer,
} from '../../src/email/mailer.js';

/**
 * `SG.`-prefixed, because `setApiKey` warns on
 * anything else and a noisy suite hides real
 * warnings.
 */
const API_KEY = 'SG.fake-key';
const SINK = 'http://sink.test:1080';

/**
 * What `createRequest` hands to the HTTP layer.
 * It renames two fields on the way out — `baseUrl`
 * becomes axios's `baseURL` and `body` becomes
 * `data` — so the merged shape is not the declared
 * `ClientRequest` and has to be named here.
 */
type MergedRequest = {
  url?: string;
  baseURL?: string;
  data?: Record<string, unknown>;
};

function merge(client: Client, data: ClientRequest): MergedRequest {
  return client.createRequest(data) as unknown as MergedRequest;
}

/**
 * `createRequest` is pure and merges the client's
 * own defaults, so recording its result proves
 * where a send would land and what it would carry
 * without opening a socket.
 */
function record(client: Client): MergedRequest[] {
  const requests: MergedRequest[] = [];
  client.request = async (data: ClientRequest) => {
    requests.push(merge(client, data));
    return [{ statusCode: 202 } as ClientResponse, {}];
  };
  return requests;
}

describe('the SendGrid base-URL seam', () => {
  it('sends to the configured base URL', async () => {
    const client = buildSendGridClient({ apiKey: API_KEY, baseUrl: SINK });
    const requests = record(client);
    const mailer = createSendGridMailer(
      { apiKey: API_KEY, baseUrl: SINK, from: 'hello@mboss.dev' },
      client,
    );

    await mailer.send({
      to: 'pat@stmarks.org',
      subject: 'hi',
      html: '<p>hi</p>',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.baseURL).toBe(SINK);
    expect(requests[0]?.url).toBe('/v3/mail/send');
  });

  it('sets the base URL after the API key, which resets it', () => {
    // `setApiKey` calls `setDefaultRequest('baseUrl', …)` itself, back to
    // the provider's own host. Written the other way round the override is
    // silently lost, and this is the assertion that catches it.
    const client = buildSendGridClient({ apiKey: API_KEY, baseUrl: SINK });

    expect(
      merge(client, { method: 'POST', url: '/v3/mail/send' }).baseURL,
    ).toBe(SINK);
  });

  it('reaches SendGrid itself under the default configuration', () => {
    const env = readEnv({
      DATABASE_URL: 'postgres://localhost:5432/mboss',
      API_BASE_URL: 'http://localhost:3001',
      INTERNAL_API_TOKEN: 'token',
      LINK_KEYS: `k1:${'a'.repeat(64)}`,
      SENDGRID_API_KEY: API_KEY,
    });
    const client = buildSendGridClient({
      apiKey: env.SENDGRID_API_KEY,
      baseUrl: env.SENDGRID_BASE_URL,
    });

    expect(
      merge(client, { method: 'POST', url: '/v3/mail/send' }).baseURL,
    ).toBe('https://api.sendgrid.com');
  });
});

describe('the SendGrid mailer', () => {
  let requests: MergedRequest[];

  beforeEach(async () => {
    const client = buildSendGridClient({ apiKey: API_KEY, baseUrl: SINK });
    requests = record(client);
    const mailer = createSendGridMailer(
      { apiKey: API_KEY, baseUrl: SINK, from: 'hello@mboss.dev' },
      client,
    );

    await mailer.send({
      to: 'pat@stmarks.org',
      subject: 'Progress update #3',
      html: '<p>hi</p>',
      headers: {
        'List-Unsubscribe':
          '<https://mboss.dev/api/unsubscribe/tok-1>, ' +
          '<mailto:unsubscribe@mboss.dev>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  });

  it('sends from the configured address under the mBoss name', () => {
    expect(requests[0]?.data?.['from']).toEqual({
      email: 'hello@mboss.dev',
      name: 'mBoss',
    });
  });

  it('passes the unsubscribe headers through to the provider', () => {
    // The template setting the headers proves
    // nothing on its own — this is where they
    // either reach the provider's JSON or are
    // dropped on the way.
    expect(requests[0]?.data?.['headers']).toEqual({
      'List-Unsubscribe':
        '<https://mboss.dev/api/unsubscribe/tok-1>, ' +
        '<mailto:unsubscribe@mboss.dev>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('sends the subject and body it was given', () => {
    expect(requests[0]?.data?.['subject']).toBe('Progress update #3');
    expect(requests[0]?.data?.['content']).toEqual([
      { type: 'text/html', value: '<p>hi</p>' },
    ]);
  });
});
