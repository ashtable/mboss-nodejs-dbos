import { Client } from '@sendgrid/client';
import { MailService } from '@sendgrid/mail';

import type { EmailMessage } from './message.js';

/**
 * The one place in the project that talks to
 * SendGrid, behind an interface small enough that
 * every test can hand the workflows a recording
 * double instead.
 */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export type MailerConfig = {
  apiKey: string;
  baseUrl: string;
  from: string;
};

/**
 * `setApiKey` sets the base URL itself, back to
 * the provider's own regional host, so the
 * override has to come after it or it is silently
 * lost — the request then goes to SendGrid while
 * the configuration says otherwise.
 */
export function buildSendGridClient(config: {
  apiKey: string;
  baseUrl: string;
}): Client {
  const client = new Client();
  client.setApiKey(config.apiKey);
  client.setDefaultRequest('baseUrl', config.baseUrl);
  return client;
}

/**
 * The `client` parameter is an ordinary
 * dependency with a production default, not a
 * test hatch: the tests hand in a client whose
 * transport they have replaced.
 *
 * Each mailer gets its own `MailService` rather
 * than configuring the package's default
 * singleton, so nothing one mailer does is
 * visible to another.
 */
export function createSendGridMailer(
  config: MailerConfig,
  client: Client = buildSendGridClient(config),
): Mailer {
  const service = new MailService();
  service.setClient(client);

  return {
    async send(message: EmailMessage): Promise<void> {
      await service.send({
        to: message.to,
        from: `mBoss <${config.from}>`,
        subject: message.subject,
        html: message.html,
        ...(message.headers === undefined ? {} : { headers: message.headers }),
      });
    },
  };
}
