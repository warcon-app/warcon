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

export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
	await migrate(db, { migrationsFolder });
}

/** True when the timescaledb extension is installed in this database. */
export async function hasTimescale(db: Db): Promise<boolean> {
	const [row] = await db.execute<{ n: number }>(
		sql`SELECT COUNT(*)::int AS n FROM pg_extension WHERE extname = 'timescaledb'`
	);
	return (row?.n ?? 0) > 0;
}
