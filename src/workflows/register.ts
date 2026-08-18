import { DBOS } from '@dbos-inc/dbos-sdk';

import type { WorkerDeps } from '../deps.js';
import { broadcastSend } from './broadcast-send.js';
import type { BroadcastSendInput } from './broadcast-send.js';
import { broadcastTestSend } from './broadcast-test-send.js';
import { confirmationEmail } from './confirmation-email.js';
import type { ConfirmationEmailInput } from './confirmation-email.js';

/**
 * Free functions, never class methods, and never
 * with a class name.
 *
 * The API enqueues these by name through
 * `DBOSClient`, which never sends a class. A
 * repeated enqueue of the same workflow id
 * returns the existing workflow only when both
 * the name and the class match, so registering
 * these as class methods would make the second
 * signup of a repeat subscriber throw on a class
 * name the API cannot supply.
 *
 * The names are the whole contract: they are
 * plain strings on this side and plain strings in
 * `mboss-nodejs-api`, with nothing in either repo
 * checking them against the other.
 */
export function registerWorkflows(deps: WorkerDeps): void {
  DBOS.registerWorkflow(
    (input: ConfirmationEmailInput) => confirmationEmail(deps, input),
    { name: 'confirmationEmail' },
  );

  DBOS.registerWorkflow(
    (input: BroadcastSendInput) => broadcastSend(deps, input),
    { name: 'broadcastSend' },
  );

  DBOS.registerWorkflow((input: unknown) => broadcastTestSend(deps, input), {
    name: 'broadcastTestSend',
  });
}
