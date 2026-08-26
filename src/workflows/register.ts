import { DBOS } from '@dbos-inc/dbos-sdk';

import type { SenderDeps, WorkerDeps } from '../deps.js';
import { bounceScan, startBounceScanOn } from './bounce-scan.js';
import type { BounceScanInput } from './bounce-scan.js';
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
 * The names are the whole contract for the three
 * the API enqueues: they are plain strings on this
 * side and plain strings in `mboss-nodejs-api`,
 * with nothing in either repo checking them
 * against the other. `bounceScan` is the one this
 * worker enqueues for itself.
 *
 * It is registered first because the senders need
 * its registered wrapper: only a registered
 * workflow can be started, so `startBounceScan`
 * cannot exist until this call has returned.
 */
export function registerWorkflows(deps: WorkerDeps): void {
  const scan = DBOS.registerWorkflow(
    (input: BounceScanInput) => bounceScan(deps, input),
    { name: 'bounceScan' },
  );

  const senderDeps: SenderDeps = {
    ...deps,
    startBounceScan: startBounceScanOn(scan),
  };

  DBOS.registerWorkflow(
    (input: ConfirmationEmailInput) => confirmationEmail(senderDeps, input),
    { name: 'confirmationEmail' },
  );

  DBOS.registerWorkflow(
    (input: BroadcastSendInput) => broadcastSend(senderDeps, input),
    { name: 'broadcastSend' },
  );

  DBOS.registerWorkflow((input: unknown) => broadcastTestSend(deps, input), {
    name: 'broadcastTestSend',
  });
}
