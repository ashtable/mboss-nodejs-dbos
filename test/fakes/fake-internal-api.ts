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

  constructor(private readonly pageSize = 100) {}

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

  statusOf(broadcastId: string, subscriberId: string): DeliveryStatus {
    return this.settled.get(`${broadcastId}:${subscriberId}`) ?? 'pending';
  }

  async getSubscriber(id: string): Promise<InternalSubscriberResponse> {
    this.calls.push(`getSubscriber:${id}`);
    const subscriber = this.subscribers.get(id);
    if (!subscriber) throw new InternalApiError(404, 'Not Found');
    return subscriber;
  }

  async recordConfirmationSent(id: string): Promise<ConfirmationSentResponse> {
    this.calls.push(`recordConfirmationSent:${id}`);
    if (!this.subscribers.has(id)) throw new InternalApiError(404, 'Not Found');
    this.confirmationSent.push(id);
    return { confirmationEmailSentAt: '2026-08-16T12:00:00.000Z' };
  }

  async getBroadcast(id: string): Promise<InternalBroadcastResponse> {
    this.calls.push(`getBroadcast:${id}`);
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
    this.flips.push(flip);

    const key = `${broadcastId}:${flip.subscriberId}`;
    const recorded = this.settled.get(key);
    if (recorded !== undefined) return { status: recorded };

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
