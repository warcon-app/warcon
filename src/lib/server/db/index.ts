// Postgres through Bun's built-in client, wrapped by Drizzle. Migrations from ./drizzle are applied
// on startup; TimescaleDB (optional but recommended) turns `samples` into a hypertable.
import { SQL } from 'bun';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import * as schema from './schema';

export { schema };

/** Opens the pool from a connection URL or from separate fields (host, user, password, database). */
export function connect(target: string | Bun.SQL.PostgresOrMySQLOptions) {
	let client: SQL;
	try {
		client =
			typeof target === 'string' ? new SQL(target, { max: 10 }) : new SQL({ ...target, max: 10 });
	} catch (err) {
		// Bun rejects the URL before connecting when the password holds / # % or ? unencoded.
		throw new Error(
			`DATABASE_URL is not a valid URL (${err instanceof Error ? err.message : String(err)}). Percent-encode the password, or pass PGHOST, PGUSER, PGPASSWORD and PGDATABASE instead.`,
			{ cause: err }
		);
	}
	const db = drizzle({ client, schema, casing: 'snake_case' });
	return { client, db };
}

export type Db = ReturnType<typeof connect>['db'];
export type SqlClient = ReturnType<typeof connect>['client'];
/** A Drizzle transaction handle, or the plain db when no transaction is open. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
	await migrate(db, { migrationsFolder });
}

/** How many migrations in the folder's journal the database has not applied yet. */
export async function pendingMigrations(db: Db, migrationsFolder: string): Promise<number> {
	const journal = JSON.parse(await Bun.file(`${migrationsFolder}/meta/_journal.json`).text()) as {
		entries: { tag: string }[];
	};
	let applied = 0;
	try {
		const [row] = await db.execute<{ n: string }>(
			sql`SELECT COUNT(*) AS n FROM drizzle.__drizzle_migrations`
		);
		applied = Number(row?.n ?? 0);
	} catch {
		applied = 0; // no migrations table yet
	}
	return Math.max(0, journal.entries.length - applied);
}

/** True when the timescaledb extension is installed in this database. */
export async function hasTimescale(db: Db): Promise<boolean> {
	const [row] = await db.execute<{ n: number }>(
		sql`SELECT COUNT(*)::int AS n FROM pg_extension WHERE extname = 'timescaledb'`
	);
	return (row?.n ?? 0) > 0;
}
