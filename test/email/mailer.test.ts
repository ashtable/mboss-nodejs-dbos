import type { EmailMessage } from '@mboss/core/email';
import { describe, expect, it } from 'vitest';

import {
  MailSendError,
  createTwilioEmailMailer,
  isTransientSendFailure,
} from '../../src/email/mailer.js';
import type { Mailer } from '../../src/email/mailer.js';

const API_KEY = 'SK_test';
const API_SECRET = 'secret_test';
const SINK = 'http://sink.test';

/**
 * The key pair as basic credentials, written out
 * rather than re-encoded here. A test that built
 * the header the same way the mailer does would
 * agree with it however wrong they both were.
 */
const BASIC = 'Basic U0tfdGVzdDpzZWNyZXRfdGVzdA==';

/** What the provider answers an accepted send. */
const ACCEPTED = {
  operationId: 'comms_operation_1',
  operationLocation:
    'https://comms.twilio.com/v1/Emails/Operations/comms_operation_1',
};

const MESSAGE: EmailMessage = {
  to: 'pat@stmarks.org',
  subject: 'Progress update #3',
  html: '<p>hi</p>',
};

const HEADERS = {
  'List-Unsubscribe':
    '<https://mboss.dev/api/unsubscribe/tok-1>, ' +
    '<mailto:unsubscribe@mboss.dev>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};

type Recorded = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
};

/**
 * A mailer whose transport records instead of
 * opening a socket, so every assertion below is
 * about the request that would have gone out.
 */
function stub(
  respond: () => { status: number; body: unknown } = () => ({
    status: 202,
    body: ACCEPTED,
  }),
): { calls: Recorded[]; mailer: Mailer } {
  const calls: Recorded[] = [];

  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const { status, body } = respond();
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    calls,
    mailer: createTwilioEmailMailer(
      {
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        baseUrl: SINK,
        from: 'hello@mboss.dev',
      },
      fetchStub,
    ),
  };
}

function bodyOf(call: Recorded | undefined): Record<string, unknown> {
  return (call?.body ?? {}) as Record<string, unknown>;
}

describe('the Twilio Email mailer', () => {
  it('posts one send to the configured base URL', async () => {
    const { calls, mailer } = stub();

    await mailer.send(MESSAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://sink.test/v1/Emails');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('authenticates with the API key pair as basic credentials', async () => {
    const { calls, mailer } = stub();

    await mailer.send(MESSAGE);

    expect(calls[0]?.headers.get('authorization')).toBe(BASIC);
  });

  it('sends from the configured address under the mBoss name', async () => {
    const { calls, mailer } = stub();

    await mailer.send(MESSAGE);

    expect(bodyOf(calls[0])).toEqual({
      from: { address: 'hello@mboss.dev', name: 'mBoss' },
      to: [{ address: 'pat@stmarks.org' }],
      content: { subject: 'Progress update #3', html: '<p>hi</p>' },
    });
  });

  it('leaves the plain-text part to the provider', async () => {
    const { calls, mailer } = stub();

    await mailer.send(MESSAGE);

    // The provider derives it from the HTML when
    // the send carries none. Generating our own
    // would be a second rendering of every
    // template to keep in step with the first.
    expect(bodyOf(calls[0])['content']).not.toHaveProperty('text');
  });

  it('passes the unsubscribe headers through to the provider', async () => {
    const { calls, mailer } = stub();

    await mailer.send({ ...MESSAGE, headers: HEADERS });

    // The template setting the headers proves
    // nothing on its own — this is where they
    // either reach the provider's JSON or are
    // dropped on the way.
    expect(bodyOf(calls[0])['content']).toEqual({
      subject: 'Progress update #3',
      html: '<p>hi</p>',
      headers: HEADERS,
    });
  });

  it('omits the header block on a message that carries none', async () => {
    const { calls, mailer } = stub();

    await mailer.send(MESSAGE);

    expect(bodyOf(calls[0])['content']).not.toHaveProperty('headers');
  });

  it('returns the operation the provider accepted', async () => {
    const { mailer } = stub();

    // A 202 says the message was taken, not that
    // it arrived. This id is the only handle the
    // bounce scan has on the send afterwards.
    await expect(mailer.send(MESSAGE)).resolves.toEqual(ACCEPTED);
  });

  it('throws a refused send carrying the status and the provider wording', async () => {
    const { mailer } = stub(() => ({
      status: 403,
      body: { status: 403, message: 'from address is not verified' },
    }));

    const error = await mailer.send(MESSAGE).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MailSendError);
    // The wording is kept because a failed
    // broadcast send writes it onto the delivery
    // row an admin reads.
    expect(error).toMatchObject({
      code: 403,
      message: 'from address is not verified',
    });
  });

  it('falls back to the status when the refusal says nothing', async () => {
    const { mailer } = stub(() => ({
      status: 502,
      body: '<html>oh dear</html>',
    }));

    await expect(mailer.send(MESSAGE)).rejects.toThrow('HTTP 502');
  });

  it('throws when an accepted send comes back without an operation', async () => {
    const { mailer } = stub(() => ({
      status: 202,
      body: {
        operationLocation:
          'https://comms.twilio.com/v1/Emails/Operations/comms_operation_1',
      },
    }));

    // A drift between this body and the
    // provider's fails at the send, rather than
    // as an undefined operation id inside a
    // bounce scan two days later.
    await expect(mailer.send(MESSAGE)).rejects.toThrow();
  });
});

describe('isTransientSendFailure', () => {
  /**
   * The provider's own error carries the HTTP
   * status as `code`.
   */
  function providerError(code: number): Error {
    return Object.assign(new Error('provider said no'), { code });
  }

  it('retries a rate limit', () => {
    expect(isTransientSendFailure(providerError(429))).toBe(true);
  });

  it('retries a provider-side failure', () => {
    expect(isTransientSendFailure(providerError(503))).toBe(true);
  });

  it('does not retry a rejected message', () => {
    // A 400 means the message itself is wrong.
    // Sending it again produces the same 400 and
    // delays the failure by three attempts.
    expect(isTransientSendFailure(providerError(400))).toBe(false);
  });

  it('retries anything that carries no status', () => {
    expect(isTransientSendFailure(new Error('socket hang up'))).toBe(true);
    expect(isTransientSendFailure(null)).toBe(true);
    expect(isTransientSendFailure('nope')).toBe(true);
  });

  it('reads the status off the error the mailer actually throws', () => {
    // The predicate and the error type have to
    // agree about where the status lives, and
    // only this case pins them together.
    expect(isTransientSendFailure(new MailSendError(429, 'slow down'))).toBe(
      true,
    );
  });
});
