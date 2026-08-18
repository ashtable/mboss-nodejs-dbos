import type { EmailMessage } from '../../src/email/message.js';
import type { Mailer } from '../../src/email/mailer.js';

/**
 * Records what would have been sent, and refuses
 * the addresses a test tells it to. The refusal
 * carries the caller's own error so a test can
 * assert on how the provider's wording reaches
 * the delivery row.
 */
export class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  private readonly refusals = new Map<string, Error>();

  refuse(address: string, error: Error): void {
    this.refusals.set(address, error);
  }

  toAddress(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }

  async send(message: EmailMessage): Promise<void> {
    const refusal = this.refusals.get(message.to);
    if (refusal) throw refusal;
    this.sent.push(message);
  }
}
