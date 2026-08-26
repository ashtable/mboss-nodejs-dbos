import type { EmailMessage } from '@mboss/core/email';

import type { Mailer, SendReceipt } from '../../src/email/mailer.js';

/**
 * Records what would have been sent, and refuses
 * the addresses a test tells it to. The refusal
 * carries the caller's own error so a test can
 * assert on how the provider's wording reaches
 * the delivery row.
 */
export class FakeMailer implements Mailer {
  /** Every message handed over, refused or not. */
  readonly attempted: EmailMessage[] = [];
  readonly sent: EmailMessage[] = [];
  private readonly refusals = new Map<string, Error>();
  private readonly oneOffRefusals = new Map<string, Error>();
  private nextOperation = 0;

  refuse(address: string, error: Error): void {
    this.refusals.set(address, error);
  }

  /**
   * Refuses the next send to this address and no
   * more — a provider hiccup that clears, rather
   * than a message it will never accept.
   */
  refuseOnce(address: string, error: Error): void {
    this.oneOffRefusals.set(address, error);
  }

  toAddress(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }

  /**
   * Every accepted send gets its own operation
   * id, the way the provider mints one, so a test
   * can tell which recipient a receipt belongs to.
   */
  async send(message: EmailMessage): Promise<SendReceipt> {
    this.attempted.push(message);

    const oneOff = this.oneOffRefusals.get(message.to);
    if (oneOff) {
      this.oneOffRefusals.delete(message.to);
      throw oneOff;
    }

    const refusal = this.refusals.get(message.to);
    if (refusal) throw refusal;
    this.sent.push(message);

    this.nextOperation += 1;
    const operationId = `op_${this.nextOperation}`;
    return {
      operationId,
      operationLocation: `https://sink.test/v1/Emails/Operations/${operationId}`,
    };
  }
}
