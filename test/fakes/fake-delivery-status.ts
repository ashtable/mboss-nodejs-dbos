import type {
  DeliveryState,
  DeliveryStatusReader,
} from '../../src/email/delivery-status.js';

/**
 * Answers what a test says became of each
 * operation, and refuses when it is told to.
 *
 * Pending is the default because it is the answer
 * the provider gives most of the time: a scan is
 * mostly a sequence of "not yet".
 */
export class FakeDeliveryStatus implements DeliveryStatusReader {
  /** Every operation id asked about, in order. */
  readonly reads: string[] = [];

  private readonly states = new Map<string, DeliveryState>();
  private everyRead: Error | undefined;
  private nextRead: Error | undefined;

  seed(operationId: string, state: DeliveryState): void {
    this.states.set(operationId, state);
  }

  /** A provider hiccup that clears on the retry. */
  failNextRead(error: Error): void {
    this.nextRead = error;
  }

  /** The provider gone, or refusing outright. */
  failEveryRead(error: Error): void {
    this.everyRead = error;
  }

  async read(operationId: string): Promise<DeliveryState> {
    this.reads.push(operationId);

    const once = this.nextRead;
    if (once !== undefined) {
      this.nextRead = undefined;
      throw once;
    }
    if (this.everyRead !== undefined) throw this.everyRead;

    return this.states.get(operationId) ?? 'pending';
  }
}
