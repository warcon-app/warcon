// Postgres through Bun's built-in client, wrapped by Drizzle. Migrations from ./drizzle are applied
// on startup; TimescaleDB (optional but recommended) turns `samples` into a hypertable.
import { SQL } from 'bun';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import * as schema from './schema';

export { schema };

export function connect(url: string) {
	const client = new SQL(url, { max: 10 });
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
	const r = await rows<{ n: number }>(
		db.execute(sql`SELECT COUNT(*)::int AS n FROM pg_extension WHERE extname = 'timescaledb'`)
	);
	return (r[0]?.n ?? 0) > 0;
}

/** Normalises db.execute() results across drivers to a plain array of rows. */
export async function rows<T>(p: Promise<unknown>): Promise<T[]> {
	const r = (await p) as T[] | { rows: T[] };
	return Array.isArray(r) ? r : (r.rows ?? []);
}
