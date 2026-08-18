import type {
  BroadcastCompleteResponse,
  ConfirmationSentResponse,
  DeliveryFlipRequest,
  DeliveryFlipResponse,
  DeliveryStatus,
  InternalBroadcastResponse,
  InternalRecipient,
  InternalRecipientsResponse,
  InternalSubscriberResponse,
} from '@mboss/zod';

import {
  InternalApiError,
  type InternalApi,
} from '../../src/api/internal-client.js';

/**
 * The calls a test can arm to fail. Naming them
 * in a union keeps the arming honest: a route
 * that does not check is not on the list.
 */
type FailableCall =
  'getSubscriber' | 'recordConfirmationSent' | 'getBroadcast' | 'flipDelivery';

/**
 * An in-memory stand-in for the API's internal
 * routes, modelling the two behaviours the worker
 * is built around.
 *
 * The recipients endpoint returns only rows still
 * pending, so a row that has been flipped simply
 * is not on a later page — that is what makes a
 * second run send only what is still outstanding.
 * And a flip is conditional: it reports whatever
 * status was recorded first, so a repeated flip
 * is a no-op the worker can keep going past.
 */
export class FakeInternalApi implements InternalApi {
  readonly calls: string[] = [];
  readonly confirmationSent: string[] = [];
  readonly flips: DeliveryFlipRequest[] = [];
  readonly completeCalls: string[] = [];

  private readonly subscribers = new Map<string, InternalSubscriberResponse>();
  private readonly broadcasts = new Map<string, InternalBroadcastResponse>();
  private readonly recipients = new Map<string, InternalRecipient[]>();
  private readonly settled = new Map<string, DeliveryStatus>();
  private readonly raced = new Map<string, DeliveryStatus>();
  private readonly armedFailures = new Map<
    FailableCall,
    { error: Error; remaining: number }
  >();

  constructor(private readonly pageSize = 100) {}

  /**
   * Makes the next call of that kind throw, and
   * only the next one — an API pod restarting, a
   * proxy answering 502, a connection reset. The
   * attempt is still recorded, so a test can count
   * how many times the worker tried.
   */
  failNextCall(call: FailableCall, error: Error): void {
    this.failNextCalls(call, 1, error);
  }

  /**
   * The same for a run of calls: not a blip but
   * the API gone for a redeploy, which is the
   * thing a retry budget is measured against.
   */
  failNextCalls(call: FailableCall, times: number, error: Error): void {
    this.armedFailures.set(call, { error, remaining: times });
  }

  private throwIfArmed(call: FailableCall): void {
    const armed = this.armedFailures.get(call);
    if (armed === undefined) return;
    armed.remaining -= 1;
    if (armed.remaining <= 0) this.armedFailures.delete(call);
    throw armed.error;
  }

  seedSubscriber(subscriber: InternalSubscriberResponse): void {
    this.subscribers.set(subscriber.id, subscriber);
  }

  seedBroadcast(
    broadcast: InternalBroadcastResponse,
    recipients: InternalRecipient[] = [],
  ): void {
    this.broadcasts.set(broadcast.id, broadcast);
    this.recipients.set(broadcast.id, recipients);
  }

  /**
   * Pretends someone else reached this row
   * between the page that listed it and the flip
   * that settles it. The flip then finds it
   * already terminal and reports the status that
   * was recorded rather than the one asked for,
   * which is what the real route does.
   */
  settleConcurrently(
    broadcastId: string,
    subscriberId: string,
    status: DeliveryStatus,
  ): void {
    this.raced.set(`${broadcastId}:${subscriberId}`, status);
  }

  statusOf(broadcastId: string, subscriberId: string): DeliveryStatus {
    return this.settled.get(`${broadcastId}:${subscriberId}`) ?? 'pending';
  }

  async getSubscriber(id: string): Promise<InternalSubscriberResponse> {
    this.calls.push(`getSubscriber:${id}`);
    this.throwIfArmed('getSubscriber');
    const subscriber = this.subscribers.get(id);
    if (!subscriber) throw new InternalApiError(404, 'Not Found');
    return subscriber;
  }

  async recordConfirmationSent(id: string): Promise<ConfirmationSentResponse> {
    this.calls.push(`recordConfirmationSent:${id}`);
    this.throwIfArmed('recordConfirmationSent');
    if (!this.subscribers.has(id)) throw new InternalApiError(404, 'Not Found');
    this.confirmationSent.push(id);
    return { confirmationEmailSentAt: '2026-08-16T12:00:00.000Z' };
  }

  async getBroadcast(id: string): Promise<InternalBroadcastResponse> {
    this.calls.push(`getBroadcast:${id}`);
    this.throwIfArmed('getBroadcast');
    const broadcast = this.broadcasts.get(id);
    if (!broadcast) throw new InternalApiError(404, 'Not Found');
    return broadcast;
  }

  async listRecipients(
    broadcastId: string,
    cursor: string | undefined,
  ): Promise<InternalRecipientsResponse> {
    this.calls.push(`listRecipients:${broadcastId}:${cursor ?? ''}`);
    const seeded = this.recipients.get(broadcastId) ?? [];

    // Keyset paging: resume after the row the
    // cursor names, then drop everything that has
    // since left pending.
    const start =
      cursor === undefined
        ? 0
        : seeded.findIndex((row) => row.subscriberId === cursor) + 1;
    const outstanding = seeded
      .slice(start)
      .filter(
        (row) => this.statusOf(broadcastId, row.subscriberId) === 'pending',
      );

    const rows = outstanding.slice(0, this.pageSize);
    const last = rows.at(-1);
    if (outstanding.length <= rows.length || last === undefined)
      return { rows };
    return { rows, nextCursor: last.subscriberId };
  }

  async flipDelivery(
    broadcastId: string,
    flip: DeliveryFlipRequest,
  ): Promise<DeliveryFlipResponse> {
    this.calls.push(`flipDelivery:${broadcastId}:${flip.subscriberId}`);
    this.throwIfArmed('flipDelivery');
    this.flips.push(flip);

    const key = `${broadcastId}:${flip.subscriberId}`;
    const recorded = this.settled.get(key) ?? this.raced.get(key);
    if (recorded !== undefined) {
      this.settled.set(key, recorded);
      return { status: recorded };
    }

    this.settled.set(key, flip.status);
    return { status: flip.status };
  }

  async completeBroadcast(id: string): Promise<BroadcastCompleteResponse> {
    this.calls.push(`completeBroadcast:${id}`);
    this.completeCalls.push(id);

    const seeded = this.recipients.get(id) ?? [];
    const count = (status: DeliveryStatus): number =>
      seeded.filter((row) => this.statusOf(id, row.subscriberId) === status)
        .length;

    return {
      status:
        count('failed') === seeded.length && seeded.length > 0
          ? 'failed'
          : 'sent',
      sentCount: count('sent'),
      failedCount: count('failed'),
      skippedCount: count('skipped'),
    };
  }
}
