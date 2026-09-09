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

/** Every jsonb column the app writes; kept in step with schema.ts. */
const JSONB_COLUMNS: [table: string, column: string][] = [
	['audit_log', 'detail'],
	['samples', 'scores'],
	['samples', 'cash'],
	['matches', 'final_scores'],
	['triggers', 'config'],
	['triggers', 'state'],
	['webhooks', 'events'],
	['webhooks', 'server_ids']
];

/**
 * Unwraps jsonb values that an older build stored double-encoded (a JSON array or object inside
 * a JSON string; see the jsonb type in schema.ts). Migration 0008 did this once, but a process
 * still running the old code keeps writing the old shape until it restarts (a rolling deploy,
 * or a dev server left open), so every start checks again. Cheap when there is nothing to fix.
 * Returns how many rows were rewritten.
 */
export async function repairLegacyJsonb(db: Db): Promise<number> {
	let fixed = 0;
	for (const [table, column] of JSONB_COLUMNS) {
		const t = sql.identifier(table);
		const c = sql.identifier(column);
		const res = await db.execute(sql`
			UPDATE ${t} SET ${c} = (${c} #>> '{}')::jsonb
			 WHERE jsonb_typeof(${c}) = 'string' AND left(${c} #>> '{}', 1) IN ('[', '{')`);
		// Bun's SQL result reports the UPDATE's row count as `count`.
		const r = res as { count?: number | null; affectedRows?: number | null };
		fixed += Number(r.count ?? r.affectedRows ?? 0);
	}
	return fixed;
}
