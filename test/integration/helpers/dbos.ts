import 'dotenv/config';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { Client } from 'pg';

/**
 * The one database this suite is allowed to
 * destroy. It is dropped and recreated before
 * every launch, which is the only way to assert
 * what DBOS creates from a known-empty start —
 * and the reason it must never be pointed at the
 * application's database.
 */
export function testDatabaseUrl(): string {
  const url = process.env['DBOS_TEST_DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DBOS_TEST_DATABASE_URL is not set. Copy .env.example to .env. ' +
        'This suite drops and recreates that database, so name a ' +
        'throwaway one, never the application database.',
    );
  }
  return url;
}

/** Connects to the maintenance database beside the one under test. */
async function withMaintenanceClient<Return>(
  url: string,
  run: (client: Client) => Promise<Return>,
): Promise<Return> {
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';

  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function resetTestDatabase(): Promise<string> {
  const url = testDatabaseUrl();
  const name = new URL(url).pathname.slice(1);

  await withMaintenanceClient(url, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  });

  return url;
}

/** Runs a query against the database under test. */
export async function queryTestDatabase<Row extends object>(
  sql: string,
): Promise<Row[]> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    const result = await client.query<Row>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * DBOS is a process-wide singleton, so a suite
 * that launches more than once has to clear the
 * registry between launches or the second
 * registration collides with the first.
 */
export async function shutdownDbos(): Promise<void> {
  await DBOS.shutdown({ deregister: true });
}
