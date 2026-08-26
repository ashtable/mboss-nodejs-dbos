import {
  BroadcastCompleteResponseSchema,
  ConfirmationSentResponseSchema,
  DeliveryFlipResponseSchema,
  EmailEventsResponseSchema,
  InternalBroadcastResponseSchema,
  InternalRecipientsResponseSchema,
  InternalSubscriberResponseSchema,
} from '@mboss/zod';
import type {
  BroadcastCompleteResponse,
  ConfirmationSentResponse,
  DeliveryFlipRequest,
  DeliveryFlipResponse,
  EmailEventsRequest,
  EmailEventsResponse,
  InternalBroadcastResponse,
  InternalRecipientsResponse,
  InternalSubscriberResponse,
} from '@mboss/zod';
import type { z } from 'zod';

/**
 * The worker holds no application data of its
 * own: everything it knows about a subscriber or
 * a broadcast comes through these seven routes.
 *
 * Every response is parsed with the same schema
 * the API answers with, so a drift between the
 * two repos surfaces here as a parse failure
 * rather than as an `undefined` several frames
 * later, in the middle of a send.
 */
export interface InternalApi {
  getSubscriber(id: string): Promise<InternalSubscriberResponse>;
  recordConfirmationSent(id: string): Promise<ConfirmationSentResponse>;
  getBroadcast(id: string): Promise<InternalBroadcastResponse>;
  listRecipients(
    broadcastId: string,
    cursor: string | undefined,
  ): Promise<InternalRecipientsResponse>;
  flipDelivery(
    broadcastId: string,
    flip: DeliveryFlipRequest,
  ): Promise<DeliveryFlipResponse>;
  completeBroadcast(id: string): Promise<BroadcastCompleteResponse>;
  postEmailEvents(events: EmailEventsRequest): Promise<EmailEventsResponse>;
}

/**
 * A response the API refused. `status` is what
 * decides whether retrying could help; `message`
 * is the API's own wording, kept because a failed
 * send writes it onto the delivery row an admin
 * reads.
 */
export class InternalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'InternalApiError';
  }
}

/**
 * Anything that never got an answer is worth
 * another try — that is what `fetch` throwing
 * means. An answer in the 4xx range is not: a 404
 * for a subscriber id will be a 404 next time
 * too.
 */
export function isRetryableApiError(error: unknown): boolean {
  if (error instanceof InternalApiError) return error.status >= 500;
  return true;
}

export function createInternalApi(config: {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}): InternalApi {
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    body?: unknown,
  ): Promise<z.infer<Schema>> {
    const response = await doFetch(`${config.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new InternalApiError(
        response.status,
        reason(payload, response.status),
      );

    return schema.parse(payload);
  }

  return {
    getSubscriber: (id) =>
      call(`/internal/v1/subscribers/${id}`, InternalSubscriberResponseSchema),

    recordConfirmationSent: (id) =>
      call(
        `/internal/v1/subscribers/${id}/confirmation-sent`,
        ConfirmationSentResponseSchema,
        {},
      ),

    getBroadcast: (id) =>
      call(`/internal/v1/broadcasts/${id}`, InternalBroadcastResponseSchema),

    listRecipients: (broadcastId, cursor) =>
      call(
        `/internal/v1/broadcasts/${broadcastId}/recipients` +
          (cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`),
        InternalRecipientsResponseSchema,
      ),

    flipDelivery: (broadcastId, flip) =>
      call(
        `/internal/v1/broadcasts/${broadcastId}/deliveries`,
        DeliveryFlipResponseSchema,
        flip,
      ),

    completeBroadcast: (id) =>
      call(
        `/internal/v1/broadcasts/${id}/complete`,
        BroadcastCompleteResponseSchema,
        {},
      ),

    postEmailEvents: (events) =>
      call('/internal/v1/email-events', EmailEventsResponseSchema, events),
  };
}

/** The API answers every refusal in one shape. */
function reason(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null) {
    const shape = payload as { message?: unknown; error?: unknown };
    if (typeof shape.message === 'string') return shape.message;
    if (typeof shape.error === 'string') return shape.error;
  }
  return `HTTP ${status}`;
}
