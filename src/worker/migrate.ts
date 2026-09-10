// bun run db:migrate — applies pending migrations and exits. The split roles refuse to start
// while any are pending, so run this (Compose's `migrate` service does) before web and worker.
import { resolve } from 'node:path';
import { connect, runMigrations } from '$lib/server/db';

const url = process.env.DATABASE_URL;
const target =
	url ||
	(process.env.PGHOST && process.env.PGPASSWORD !== undefined
		? {
				hostname: process.env.PGHOST,
				port: Number(process.env.PGPORT) || 5432,
				username: process.env.PGUSER || 'warcon',
				password: process.env.PGPASSWORD,
				database: process.env.PGDATABASE || 'warcon'
			}
		: null);
if (!target) {
	console.error('Set DATABASE_URL, or PGHOST and PGPASSWORD.');
	process.exit(2);
}
const { client, db } = connect(target);
await runMigrations(db, resolve(process.cwd(), 'drizzle'));
console.log('[warcon] migrations applied');
await client.end();
