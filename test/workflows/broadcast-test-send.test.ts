import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerDeps } from '../../src/deps.js';
import { broadcastTestSend } from '../../src/workflows/broadcast-test-send.js';
import { FakeInternalApi } from '../fakes/fake-internal-api.js';
import { FakeMailer } from '../fakes/fake-mailer.js';
import { testDeps } from '../helpers/deps.js';
import { reset } from '../helpers/dbos-double.js';

vi.mock(
  '@dbos-inc/dbos-sdk',
  async () => await import('../helpers/dbos-double.js'),
);

const REQUEST = {
  subject: 'Progress update #3 — the canvas is alive',
  bodyMarkdown: '# The canvas is alive.\n\nFirst look at the mBoss canvas.',
  to: 'admin@mboss.dev',
};

let api: FakeInternalApi;
let mailer: FakeMailer;
let deps: WorkerDeps;

beforeEach(() => {
  reset();
  api = new FakeInternalApi();
  mailer = new FakeMailer();
  deps = testDeps({ api, mailer });
});

describe('broadcastTestSend', () => {
  it('sends the broadcast email to the one given address', async () => {
    await broadcastTestSend(deps, REQUEST);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('admin@mboss.dev');
    expect(mailer.sent[0]?.subject).toBe(REQUEST.subject);
    expect(mailer.sent[0]?.html).toContain('>The canvas is alive.</div>');
  });

  it('touches no broadcast route', async () => {
    await broadcastTestSend(deps, REQUEST);

    // A test send writes no delivery rows and has
    // no broadcast to complete. It exists only to
    // put the draft in front of the person
    // writing it.
    expect(api.calls).toEqual([]);
  });

  it('sends without a manage link or unsubscribe headers', async () => {
    await broadcastTestSend(deps, REQUEST);

    // There is no subscriber behind this address,
    // so any token minted for it could never
    // verify. A dead unsubscribe link in a real
    // inbox is worse than none.
    expect(mailer.sent[0]?.headers).toBeUndefined();
    expect(mailer.sent[0]?.html).not.toContain('/u/');
  });

  it('sends again when asked again', async () => {
    await broadcastTestSend(deps, REQUEST);
    await broadcastTestSend(deps, REQUEST);

    // The API enqueues this with no workflow id
    // on purpose: an admin who asks for a second
    // test send wants a second email.
    expect(mailer.sent).toHaveLength(2);
  });

  it('rejects an input the wire schema would not accept', async () => {
    const withoutRecipient: Record<string, unknown> = { ...REQUEST };
    delete withoutRecipient['to'];

    await expect(broadcastTestSend(deps, withoutRecipient)).rejects.toThrow();
    expect(mailer.sent).toEqual([]);
  });
});
