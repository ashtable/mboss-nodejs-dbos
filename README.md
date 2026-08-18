# mboss-nodejs-dbos

The mBoss DBOS worker: the one process that sends email.

It holds the SendGrid key — no other service does — and it owns no
application data. Everything it needs about a subscriber or a broadcast it
reads over the API's `/internal/v1/*` routes; the only Postgres it touches
is DBOS's own `dbos` schema, which DBOS creates at launch.

## Workflows

Three, all registered as free functions on one queue, `email`, and all
enqueued by `mboss-nodejs-api` through `DBOSClient`. The names are a wire
contract with that repo — nothing enforces the match but the tests.

| Workflow            | Input                                           | What it does                                                                                                      |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `confirmationEmail` | `{ subscriberId }`                              | Fetches the subscriber, sends the waitlist confirmation with a signed manage link, records the send.              |
| `broadcastSend`     | `{ broadcastId }`                               | Fetches the broadcast, pages its pending recipients, sends one email per recipient, then completes the broadcast. |
| `broadcastTestSend` | `{ subject, bodyMarkdown, teaserImageUrl, to }` | Renders the broadcast to one address. Writes no delivery rows and is deliberately repeatable.                     |

## Environment

| Variable                   | Required | Notes                                                                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | yes      | DBOS's system tables live in this database, in schema `dbos`.                                              |
| `DBOS_SYSTEM_DATABASE_URL` | no       | Defaults to `DATABASE_URL`. Set it only to point DBOS at a different database.                             |
| `API_BASE_URL`             | yes      | Where `/internal/v1/*` lives.                                                                              |
| `INTERNAL_API_TOKEN`       | yes      | Bearer token for those routes; must match the API's.                                                       |
| `LINK_KEYS`                | yes      | The same signing ring the API verifies with — this service mints the manage links.                         |
| `SENDGRID_API_KEY`         | yes      |                                                                                                            |
| `SENDGRID_BASE_URL`        | no       | Defaults to `https://api.sendgrid.com`. The end-to-end suite points it at a mail sink.                     |
| `MAIL_FROM`                | no       | Defaults to `hello@mboss.dev`.                                                                             |
| `SITE_URL`                 | no       | Defaults to `https://mboss.dev`. Manage and unsubscribe links are built from it.                           |
| `DBOS_TEST_DATABASE_URL`   | no       | Integration suite only. It drops and recreates this database, so never name the application database here. |

## Running it

```sh
docker compose up -d postgres   # from the superproject
cp .env.example .env
npm install
npm run dev
```

The worker binds no port: DBOS's admin server is off by default, and this
process serves nothing.

## Tests

```sh
npm test              # hermetic — no database, no network
npm run test:integration   # local only; needs Postgres
```

They are separate because they prove different things. The hermetic suite
covers this repo's own behaviour — step order, retry policies, what the
templates render — and runs in CI with nothing but a checkout. The
integration suite covers DBOS's guarantees, which no doubled SDK can
demonstrate: that a repeated workflow id runs once, that a queue cannot be
registered before launch, that the system tables stay in the `dbos` schema.

## Operations

Nothing watches this worker. A workflow that throws is marked `ERROR` and
stops there: no retry, no alert, no admin route. Finding one is a question
somebody has to ask.

The SDK ships the CLI that asks it. Run it inside the service — the
worker's `DATABASE_URL` names a `*.railway.internal` host, which resolves
nowhere else — and use the local binary, for the same reason the
entrypoint does.

```sh
railway ssh --service mboss-nodejs-dbos
cd /app
export SYSDB="${DBOS_SYSTEM_DATABASE_URL:-$DATABASE_URL}"

# What is errored.
./node_modules/.bin/dbos workflow list --status ERROR --sys-db-url "$SYSDB"

# Which step failed: the one with a non-null
# `error`. Note its `functionID`.
./node_modules/.bin/dbos workflow steps "$WF" --sys-db-url "$SYSDB"

# Run it again from that step, under a new id.
./node_modules/.bin/dbos workflow fork "$WF" --step 2 --sys-db-url "$SYSDB"
```

Spell `--status` and `--step` out. Both are `-S` in short form — on `list`
and on `fork` respectively — and they are unrelated options, which is a
copy-paste waiting to happen.

Fork, not resume. `resume` updates only workflows that are neither
`SUCCESS` nor `ERROR`, so against an errored one it matches nothing, exits
cleanly and leaves it exactly as it was: it looks like it worked. `fork`
has no such exclusion. It copies every step _before_ the one named into a
new workflow id and re-runs from there, so work that already succeeded is
not repeated — a confirmation that died recording its send is not sent
again, only recorded. Name the step that failed, not the one after it:
that step writes its own row, with its error, before the throw leaves it,
so it is on the `steps` listing and everything before it is what gets
copied.

Fix the cause before forking, because the forked run starts immediately.
Let the fork generate its own id; the errored one is taken.

`workflow steps` prints one JSON array with a row per step and takes no
filter, so on a large broadcast that is thousands of entries. Narrow it:

```sh
./node_modules/.bin/dbos workflow steps "$WF" --sys-db-url "$SYSDB" |
  node -pe 'JSON.parse(require("fs").readFileSync(0)).filter(s=>s.error)'
```

A forked workflow runs on DBOS's own internal queue rather than `email`,
since the command takes no queue name. It still runs — this process
listens to every queue — and it does not wait behind a broadcast holding
`email`'s one slot. It does inherit the errored workflow's application
version, and a worker dequeues only its own; that version is a hash of the
registered workflow functions plus the SDK, so it moves on an SDK upgrade
rather than on an ordinary code change. If it has moved, pass
`--application-version` with what the worker logs at startup as
`Application version:`, or the fork sits `ENQUEUED` for ever with nothing
to say so.

### A confirmation that errored

Permanent until somebody forks it. The API derives the workflow id from the
subscriber and the time of their last confirmation, and that time is
written by the last step of this very workflow — so while it sits `ERROR`,
every later signup by that person derives the same id, attaches to the same
dead workflow and sends nothing. Forking writes the timestamp, which moves
the id on and closes the loop.

### A broadcast stuck in `sending`

The run stopped part way through its audience because the API would not
record a delivery. Stopping is deliberate, and it is what makes the state
recoverable: completing would have counted the unrecorded row as handled
and marked the broadcast sent, which nothing can undo. Every recipient the
run never reached still has a `pending` delivery row.

The errored workflow is `broadcast:<id>` and the failing step is named
`flip:<subscriberId>`, so `workflow steps` names the recipient it stopped
on. Fix the cause and fork from that step: the deliveries already recorded
are copied, the send for that recipient is replayed rather than repeated,
and the run carries on through the rest of the audience and completes.
Re-enqueuing under a fresh workflow id also finishes the broadcast — the
recipients route returns only pending rows — but it re-sends to the
recipient whose flip was refused, because nothing was ever recorded for
them.

One case has no fix from here: a flip refused 404 means the recipients
route returned a subscriber whose delivery row does not exist, and no route
creates or repairs one. A fork will hit the identical 404 at the identical
recipient. That is a database-level repair, not an operation this section
covers.
