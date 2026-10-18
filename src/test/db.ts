// A real database for the tests that need one. TEST_DATABASE_URL names a Postgres server the
// tests may create databases on; every run makes its own `warcon_test_<random>`, migrates it and
// drops it at the end. DATABASE_URL is never read: a developer's .env points it at the database
// they work in, and `bun test` loads that file.
//
//   TEST_DATABASE_URL=postgres://warcon:warcon@127.0.0.1:5434/postgres bun test
//
// Without it the database suites are skipped (CI sets it, and fails when it is missing).
import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { sql as query } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import type { Env } from '$lib/server/env';

const PREFIX = 'warcon_test_';
const base = process.env.TEST_DATABASE_URL;

if (!base && process.env.CI)
	throw new Error('TEST_DATABASE_URL is not set: CI must run the database suites.');

/** False when there is no test database to use; suites pass it to describe.skipIf. */
export const hasTestDb = !!base;

/**
 * Match lines for a database migrated only part of the way, with just the columns each one gives:
 * Drizzle's insert names every column the schema has, and one a later migration adds is not there
 * yet.
 */
export async function insertEarlyLines(db: DbOrTx, rows: Record<string, unknown>[]): Promise<void> {
	for (const r of rows) {
		const columns = Object.keys(r).map((k) =>
			query.identifier(k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
		);
		const values = Object.values(r).map((v) => query`${v}`);
		await db.execute(
			query`INSERT INTO match_players (${query.join(columns, query`, `)}) VALUES (${query.join(values, query`, `)})`
		);
	}
}

type Shared = { env: Promise<Env>; name: string };
// One database per `bun test` process, shared by every file: the module registry is per file for
// mocked modules, so the handle lives on globalThis.
const shared = globalThis as typeof globalThis & { __warconTestDb?: Shared };

const admin = () => new SQL(base!, { max: 1 });

async function create(name: string): Promise<Env> {
	const sql = admin();
	// Databases left by runs that were killed before they could drop theirs. One still in use
	// (another run on this machine) refuses the drop, which is what should happen.
	const stale = await sql`SELECT datname FROM pg_database WHERE datname LIKE ${PREFIX + '%'}`;
	for (const row of stale) await sql.unsafe(`DROP DATABASE "${row.datname}"`).catch(() => {});
	await sql.unsafe(`CREATE DATABASE "${name}"`);
	await sql.close();

	const url = new URL(base!);
	url.pathname = `/${name}`;
	for (const k of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) delete process.env[k];
	Object.assign(process.env, {
		DATABASE_URL: url.href,
		WARCON_ROLE: 'all',
		ORIGIN: 'http://localhost:5173',
		BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
		ENCRYPTION_KEY: randomBytes(32).toString('base64'),
		ALLOW_ORG_SIGNUP: 'true',
		AUDIT_LOG_READS: ''
	});
	delete process.env.METRICS_TOKEN;
	delete process.env.SETUP_TOKEN;
	// initEnv rather than a hand-built Env: route handlers read getEnv(), and this is the only
	// thing that sets it. It applies the migrations from ./drizzle.
	const { initEnv } = await import('$lib/server/env');
	return initEnv({ role: 'all' });
}

/** The migrated test database, as the Env every server function takes. */
export function testEnv(): Promise<Env> {
	if (!base)
		throw new Error('No TEST_DATABASE_URL; guard the suite with describe.skipIf(!hasTestDb).');
	if (!shared.__warconTestDb) {
		const name = PREFIX + randomBytes(6).toString('hex');
		shared.__warconTestDb = { name, env: create(name) };
	}
	return shared.__warconTestDb.env;
}

/** Called once, after the last test file (setup.ts). */
export async function dropTestDb(): Promise<void> {
	const held = shared.__warconTestDb;
	if (!held) return;
	shared.__warconTestDb = undefined;
	const env = await held.env.catch(() => null);
	await env?.sql.close().catch(() => {});
	const sql = admin();
	await sql.unsafe(`DROP DATABASE IF EXISTS "${held.name}" WITH (FORCE)`).catch(() => {});
	await sql.close();
}
