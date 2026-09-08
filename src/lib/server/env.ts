// Process configuration plus the database. Initialised once at startup (hooks.server.ts).
import { resolve } from 'node:path';
import { env as processEnv } from '$env/dynamic/private';
import { connect, hasTimescale, runMigrations, type Db, type SqlClient } from './db';

export interface Env {
	db: Db;
	/** Raw Bun SQL client: reserved connections (poller leader lock), shutdown. */
	sql: SqlClient;
	timescale: boolean;
	/** The exact public URL (scheme, host, port): Better Auth's base URL and trusted origin. */
	ORIGIN: string;
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
	/** Let anyone create an account and their own organisation from /sign-up. */
	ALLOW_ORG_SIGNUP?: string;
	/** Self-serve limits: orgs one person may create, servers one org may hold (site owner can raise per org). */
	MAX_ORGS_PER_USER?: string;
	MAX_SERVERS_PER_ORG?: string;
	/** Cloudflare Turnstile on the password sign-up forms; both keys, or neither. */
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	/** Accept self-signed certificates on https game servers. */
	GAME_TLS_INSECURE?: string;
	/** Analytics sampling interval in seconds; 0 disables the poller. */
	POLL_SECONDS?: string;
}

export const flag = (value: string | undefined, fallback = false): boolean =>
	value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

/** A positive integer setting, or the fallback when unset or nonsense. */
export const positiveInt = (value: string | undefined, fallback: number): number => {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const DEFAULT_MAX_ORGS_PER_USER = 3;
export const DEFAULT_MAX_SERVERS_PER_ORG = 10;
export const maxOrgsPerUser = (env: Pick<Env, 'MAX_ORGS_PER_USER'>) =>
	positiveInt(env.MAX_ORGS_PER_USER, DEFAULT_MAX_ORGS_PER_USER);
export const maxServersPerOrg = (env: Pick<Env, 'MAX_SERVERS_PER_ORG'>) =>
	positiveInt(env.MAX_SERVERS_PER_ORG, DEFAULT_MAX_SERVERS_PER_ORG);

/** Discord sign-in (and account creation through invite links) is on when both secrets are set. */
export const discordEnabled = (
	env: Pick<Env, 'DISCORD_CLIENT_ID' | 'DISCORD_CLIENT_SECRET'>
): boolean => Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);

/** The Turnstile site key for the browser when the challenge is on, else null. */
export const turnstileSiteKey = (
	env: Pick<Env, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>
): string | null =>
	env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null;

/** Host name of the built-in mock game server (when ALLOW_DEMO_SERVER is on). */
export const DEMO_HOST = 'demo';

export function isDemoServer(
	env: Pick<Env, 'ALLOW_DEMO_SERVER'>,
	server: { host: string }
): boolean {
	return flag(env.ALLOW_DEMO_SERVER, false) && server.host.trim().toLowerCase() === DEMO_HOST;
}

/** ORIGIN must be a bare origin: scheme, host and optional port, nothing after. */
function parseOrigin(value: string | undefined): string {
	const raw = (value || '').trim();
	let url: URL | null = null;
	try {
		url = new URL(raw);
	} catch {
		/* reported below */
	}
	if (!url || url.origin !== raw || !/^https?:$/.test(url.protocol))
		throw new Error(
			`ORIGIN must be the exact URL people open, e.g. https://rcon.example.com or http://localhost:5173 (got ${JSON.stringify(raw)}).`
		);
	return url.origin;
}

let cached: Env | null = null;

/** Reads configuration, connects, applies migrations. Called once from the server init hook. */
export async function initEnv(): Promise<Env> {
	const origin = parseOrigin(processEnv.ORIGIN);
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
		ORIGIN: origin,
		BETTER_AUTH_SECRET: processEnv.BETTER_AUTH_SECRET,
		ENCRYPTION_KEY: processEnv.ENCRYPTION_KEY,
		SETUP_TOKEN: processEnv.SETUP_TOKEN,
		STEAM_API_KEY: processEnv.STEAM_API_KEY,
		DISCORD_CLIENT_ID: processEnv.DISCORD_CLIENT_ID,
		DISCORD_CLIENT_SECRET: processEnv.DISCORD_CLIENT_SECRET,
		APP_NAME: processEnv.APP_NAME,
		AUDIT_LOG_READS: processEnv.AUDIT_LOG_READS,
		ALLOW_DEMO_SERVER: processEnv.ALLOW_DEMO_SERVER ?? 'true',
		ALLOW_ORG_SIGNUP: processEnv.ALLOW_ORG_SIGNUP,
		MAX_ORGS_PER_USER: processEnv.MAX_ORGS_PER_USER,
		MAX_SERVERS_PER_ORG: processEnv.MAX_SERVERS_PER_ORG,
		TURNSTILE_SITE_KEY: processEnv.TURNSTILE_SITE_KEY,
		TURNSTILE_SECRET_KEY: processEnv.TURNSTILE_SECRET_KEY,
		GAME_TLS_INSECURE: processEnv.GAME_TLS_INSECURE,
		POLL_SECONDS: processEnv.POLL_SECONDS
	};
	return cached;
}

/** The environment after initEnv() resolved (SvelteKit runs the init hook before any request). */
export function getEnv(): Env {
	if (!cached) throw new Error('Environment not initialised yet.');
	return cached;
}
