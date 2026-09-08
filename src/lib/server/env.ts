// Process configuration plus the database. Initialised once at startup (hooks.server.ts).
import { resolve } from 'node:path';
import { env as processEnv } from '$env/dynamic/private';
import { connect, hasTimescale, runMigrations, type Db, type SqlClient } from './db';

export interface Env {
	db: Db;
	/** Raw Bun SQL client: reserved connections (poller leader lock), shutdown. */
	sql: SqlClient;
	timescale: boolean;
	/** Better Auth session signing secret. */
	BETTER_AUTH_SECRET?: string;
	/** base64 of 32 random bytes; encrypts stored RCON passwords. */
	ENCRYPTION_KEY?: string;
	/** Optional: required by first-run owner setup when set. */
	SETUP_TOKEN?: string;
	/** Optional: Steam Web API key for persona/avatar lookup. */
	STEAM_API_KEY?: string;
	DISCORD_CLIENT_ID?: string;
	DISCORD_CLIENT_SECRET?: string;
	APP_NAME?: string;
	AUDIT_LOG_READS?: string;
	ALLOW_DEMO_SERVER?: string;
	/** "true" when a reverse proxy sets X-Forwarded-For / CF-Connecting-IP. */
	TRUST_PROXY?: string;
	/** Accept self-signed certificates on https game servers. */
	GAME_TLS_INSECURE?: string;
	/** Analytics sampling interval in seconds; 0 disables the poller. */
	POLL_SECONDS?: string;
}

export const flag = (value: string | undefined, fallback = false): boolean =>
	value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

let cached: Env | null = null;
let pending: Promise<Env> | null = null;

/** Connects, applies migrations and caches the environment. Safe to call more than once. */
export function initEnv(): Promise<Env> {
	if (cached) return Promise.resolve(cached);
	if (!pending) {
		pending = (async () => {
			const url = processEnv.DATABASE_URL;
			if (!url) throw new Error('DATABASE_URL is not set (postgres://user:pass@host:5432/warcon).');
			const { client, db } = connect(url);
			await runMigrations(db, resolve(process.cwd(), 'drizzle'));
			const timescale = await hasTimescale(db);
			console.log(`[warcon] database ready (timescaledb ${timescale ? 'on' : 'off'})`);
			cached = {
				db,
				sql: client,
				timescale,
				BETTER_AUTH_SECRET: processEnv.BETTER_AUTH_SECRET,
				ENCRYPTION_KEY: processEnv.ENCRYPTION_KEY,
				SETUP_TOKEN: processEnv.SETUP_TOKEN,
				STEAM_API_KEY: processEnv.STEAM_API_KEY,
				DISCORD_CLIENT_ID: processEnv.DISCORD_CLIENT_ID,
				DISCORD_CLIENT_SECRET: processEnv.DISCORD_CLIENT_SECRET,
				APP_NAME: processEnv.APP_NAME,
				AUDIT_LOG_READS: processEnv.AUDIT_LOG_READS,
				ALLOW_DEMO_SERVER: processEnv.ALLOW_DEMO_SERVER ?? 'true',
				TRUST_PROXY: processEnv.TRUST_PROXY,
				GAME_TLS_INSECURE: processEnv.GAME_TLS_INSECURE,
				POLL_SECONDS: processEnv.POLL_SECONDS
			};
			return cached;
		})().catch((err) => {
			pending = null;
			throw err;
		});
	}
	return pending;
}

/** The environment after initEnv() resolved (SvelteKit runs the init hook before any request). */
export function getEnv(): Env {
	if (!cached) throw new Error('Environment not initialised yet.');
	return cached;
}
