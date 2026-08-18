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
