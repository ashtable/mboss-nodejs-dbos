import { describe, expect, it } from 'vitest';

import { createTwilioEmailStatus } from '../../src/email/delivery-status.js';
import type { DeliveryStatusReader } from '../../src/email/delivery-status.js';
import { MailSendError } from '../../src/email/mailer.js';

const API_KEY = 'SK_test';
const API_SECRET = 'secret_test';
const SINK = 'http://sink.test';

/**
 * The same key pair the mailer sends, written out
 * rather than re-encoded here. Both clients talk
 * to one provider, so they had better be sending
 * one credential.
 */
const BASIC = 'Basic U0tfdGVzdDpzZWNyZXRfdGVzdA==';

const OPERATION = 'comms_operation_1';

type Recorded = { url: string; method: string; headers: Headers };

function stub(
  respond: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { emails: [{ status: 'QUEUED' }] },
  }),
): { calls: Recorded[]; status: DeliveryStatusReader } {
  const calls: Recorded[] = [];

  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    const { status, body } = respond();
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    calls,
    status: createTwilioEmailStatus(
      { apiKey: API_KEY, apiSecret: API_SECRET, baseUrl: SINK },
      fetchStub,
    ),
  };
}

/** A reader whose one email is in that state. */
function reading(providerStatus: string): DeliveryStatusReader {
  return stub(() => ({
    status: 200,
    body: { emails: [{ status: providerStatus }] },
  })).status;
}

describe('the Twilio Email status reader', () => {
  it('asks for the one email the operation sent', async () => {
    const { calls, status } = stub();

    await status.read(OPERATION);

    // Every mBoss send goes to a single address,
    // so the operation has exactly one email
    // behind it and one page is the whole answer.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'http://sink.test/v1/Emails?operationId=comms_operation_1&pageSize=1',
    );
    expect(calls[0]?.method).toBe('GET');
  });

  it('escapes an operation id that would not survive a query string', async () => {
    const { calls, status } = stub();

    await status.read('comms operation/1');

    expect(calls[0]?.url).toContain('operationId=comms%20operation%2F1');
  });

  it('authenticates with the API key pair as basic credentials', async () => {
    const { calls, status } = stub();

    await status.read(OPERATION);

    expect(calls[0]?.headers.get('authorization')).toBe(BASIC);
  });

  it.each(['UNDELIVERED', 'FAILED'])(
    'counts %s as a bounce',
    async (providerStatus) => {
      await expect(reading(providerStatus).read(OPERATION)).resolves.toBe(
        'bounced',
      );
    },
  );

  it.each(['DELIVERED', 'OPENED', 'CANCELED'])(
    'counts %s as settled',
    async (providerStatus) => {
      await expect(reading(providerStatus).read(OPERATION)).resolves.toBe(
        'settled',
      );
    },
  );

  it.each(['SCHEDULED', 'QUEUED', 'SENT', 'INBOUND'])(
    'counts %s as still pending',
    async (providerStatus) => {
      // `SENT` is deliberately pending: the
      // provider has handed the message on, and a
      // bounce can still come back from the far
      // side.
      await expect(reading(providerStatus).read(OPERATION)).resolves.toBe(
        'pending',
      );
    },
  );

  it('counts a status it has never heard of as still pending', async () => {
    // A state the provider adds later must not
    // fail the scan. Pending is the answer that
    // costs nothing: the next pass asks again.
    await expect(reading('TELEPORTED').read(OPERATION)).resolves.toBe(
      'pending',
    );
  });

  it('counts an empty list as still pending', async () => {
    const { status } = stub(() => ({ status: 200, body: { emails: [] } }));

    // The email row may not exist yet on the first
    // pass, an hour after the send was accepted.
    // That is not an error.
    await expect(status.read(OPERATION)).resolves.toBe('pending');
  });

  it('throws a refusal carrying the status, so the retry predicate can read it', async () => {
    const { status } = stub(() => ({
      status: 503,
      body: { status: 503, message: 'Service Unavailable' },
    }));

    const error = await status
      .read(OPERATION)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MailSendError);
    expect(error).toMatchObject({ code: 503, message: 'Service Unavailable' });
  });

  it('throws when the list body has drifted', async () => {
    const { status } = stub(() => ({ status: 200, body: { items: [] } }));

    // Same reason the mailer parses its own
    // response: a shape change surfaces here
    // rather than as an undefined status that
    // quietly reads as pending forever.
    await expect(status.read(OPERATION)).rejects.toThrow();
  });
});
