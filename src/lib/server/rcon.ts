// Server-side client for the WDRCON HTTP API (mirrors rcon.wardogs.com's js/api.js).
import type { Env } from './env';
import { flag, isDemoServer } from './env';
import { gameRequest, TransportError, type GameResponse, type GameTarget } from './transport';
import { mockHandle } from './mockgame';
import { decryptSecret } from './crypto';
import { ApiError } from './http';
import { assertReachableTarget, pinnedAddresses } from './hostpolicy';
import type { ServerRow } from './access';

/** A non-2xx answer (or no answer) from the game server. Its message is meant for the operator. */
/**
 * Builds the error for a non-2xx answer. A route the build does not serve comes back as
 * 404 `not_found` "No such endpoint." (live build CL-499480), the same code family a missing ban
 * or player uses (`ban_not_found`...), so it is renamed `no_route` here and given a message that
 * says which route is missing; callers can then tell "not served" from "not there".
 */
export function classifyGameError(
	method: string,
	path: string,
	status: number,
	statusText: string,
	parsed: any,
	headers: Record<string, string> = {}
): GameError {
	const code = parsed?.error?.code || '';
	const message = parsed?.error?.message || '';
	const route = `${method.toUpperCase()} ${path.split('?')[0]}`;
	if (status === 429) {
		// The listener's per-IP limit (600/min on live builds, Retry-After exposed since CL-501228):
		// not an outage, so callers back off for the stated time instead of counting a failure.
		const retryAfterMs = parseRetryAfterMs(headers['retry-after']);
		const e = new GameError(
			429,
			`The game server is rate limiting this panel (${message || 'too many requests from this address'}); retry in ${Math.ceil(retryAfterMs / 1000)} s.`,
			'rate_limited',
			parsed
		);
		e.retryAfterMs = retryAfterMs;
		return e;
	}
	if (status === 404 && code === 'not_found' && /no such endpoint/i.test(message)) {
		return new GameError(404, `This server build does not serve ${route}.`, 'no_route', parsed);
	}
	if (status === 405) {
		return new GameError(
			405,
			`This server build does not serve ${route} (${message || 'method not allowed'}).`,
			code || 'method_not_allowed',
			parsed
		);
	}
	return new GameError(
		status,
		message || `Server answered ${status}${statusText ? ' ' + statusText : ''}.`,
		code,
		parsed
	);
}

export class GameError extends ApiError {
	/** for `rate_limited`: how long the listener asked us to wait (1–60 s, 5 s when it did not say) */
	retryAfterMs = 0;
	constructor(
		status: number,
		message: string,
		code = '',
		public body: any = null
	) {
		super(status, message, code);
	}
}

const RETRY_AFTER_DEFAULT_MS = 5000;
const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 60_000;

/** A Retry-After header (delta seconds or an HTTP date) as milliseconds, clamped to 1–60 s; 5 s when missing or unreadable. */
export function parseRetryAfterMs(value: string | undefined | null, now = Date.now()): number {
	const v = (value || '').trim();
	let ms = NaN;
	if (/^\d+$/.test(v)) ms = Number(v) * 1000;
	else if (v) {
		const at = Date.parse(v);
		if (!Number.isNaN(at)) ms = at - now;
	}
	if (!Number.isFinite(ms)) return RETRY_AFTER_DEFAULT_MS;
	return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

export { DEMO_HOST, isDemoServer } from './env';

export class WardogsClient {
	private target: GameTarget;
	/** the panel's id for the server, for what an action keeps per server */
	readonly serverId: string;
	constructor(
		private env: Env,
		server: Pick<ServerRow, 'id' | 'host' | 'port' | 'scheme'>,
		private key: string,
		private demoKey: string | null,
		private timeoutMs = 10000,
		addresses: string[] = []
	) {
		this.serverId = server.id;
		this.target = { host: server.host, port: server.port, scheme: server.scheme, addresses };
	}

	static async forServer(env: Env, server: ServerRow): Promise<WardogsClient> {
		const demo = isDemoServer(env, server);
		// Resolve and validate once, then pin the connection to those addresses: the check and the
		// socket must not do two independent DNS lookups a rebind could answer differently.
		const addresses = demo ? [] : await assertTargetStillAllowed(server);
		const key = decryptSecret(env, server.passwordEnc);
		return new WardogsClient(env, server, key, demo ? server.id : null, undefined, addresses);
	}

	/** `timeoutMs`: how long this one request may take, when it is to be less than the client's. */
	async raw(
		method: string,
		path: string,
		body?: string,
		headers: Record<string, string> = {},
		timeoutMs?: number
	): Promise<GameResponse> {
		const all = { Authorization: `Bearer ${this.key}`, ...headers };
		if (this.demoKey) {
			return mockHandle(this.demoKey, method, path, all, body);
		}
		try {
			return await gameRequest(this.target, {
				method,
				path,
				headers: all,
				body,
				timeoutMs: timeoutMs ? Math.min(timeoutMs, this.timeoutMs) : this.timeoutMs,
				insecureTls: flag(this.env.GAME_TLS_INSECURE, false)
			});
		} catch (err) {
			if (err instanceof TransportError) {
				throw new GameError(502, err.message, 'unreachable');
			}
			throw err;
		}
	}

	// JSON in, JSON out. Throws GameError with the server's message on non-2xx.
	async json<T = any>(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs?: number
	): Promise<T> {
		const headers: Record<string, string> = {};
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		const res = await this.raw(
			method,
			path,
			body === undefined ? undefined : JSON.stringify(body),
			headers,
			timeoutMs
		);
		const parsed = parseJson(res.text);
		if (res.status < 200 || res.status >= 300) {
			throw classifyGameError(method, path, res.status, res.statusText, parsed, res.headers);
		}
		return (parsed ?? {}) as T;
	}

	// text/plain config document routes (POST /v1/config/validate, PUT /v1/config).
	async configCall(
		method: string,
		path: string,
		text: string,
		revision?: string
	): Promise<{ status: number; body: any; etag: string }> {
		const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
		if (revision) {
			headers['If-Match'] = `"${revision}"`;
		}
		const res = await this.raw(method, path, text, headers);
		return { status: res.status, body: parseJson(res.text) ?? {}, etag: etagOf(res.headers) };
	}
}

/** The ETag live builds send with the config document (CL-501228+): the revision, unquoted. */
export const etagOf = (headers: Record<string, string>): string =>
	(headers['etag'] || '').replace(/^W\//, '').replace(/"/g, '').trim();

/** How long one verdict on a host is reused before it is resolved again. */
const TARGET_CHECK_TTL_MS = 60_000;
const targetChecks = new Map<
	string,
	{ until: number; error: GameError | null; addresses: string[] }
>();

/**
 * Re-runs the hostpolicy check right before Warcon talks to a server, so a hostname that was
 * public when it was saved but now points somewhere internal is refused (rebinding). Returns the
 * addresses the connection must be pinned to (the ones just validated), so the socket does not
 * resolve the name a second time. Servers the site owner saved keep their private-address
 * allowance. Cached briefly per host+allowance so the poller does not resolve every server on
 * every tick.
 */
async function assertTargetStillAllowed(
	server: Pick<ServerRow, 'host' | 'allowPrivate'>
): Promise<string[]> {
	const key = `${server.allowPrivate ? 'p' : 'o'}:${server.host}`;
	const now = Date.now();
	let hit = targetChecks.get(key);
	if (!hit || hit.until <= now) {
		let error: GameError | null = null;
		let addresses: string[] = [];
		try {
			addresses = pinnedAddresses(
				server.host,
				await assertReachableTarget(server.host, server.allowPrivate)
			);
		} catch (err) {
			if (!(err instanceof ApiError)) throw err;
			// The policy's own message names the host and what it resolves to, which is for whoever
			// is saving the target. This one is stored as the live error for every viewer.
			error = new GameError(
				err.status,
				err.code === 'unresolvable'
					? "The game server's address does not resolve."
					: "The game server's address is not one Warcon may connect to. An owner can check it in the server's settings.",
				err.code || 'blocked_host'
			);
		}
		hit = { until: now + TARGET_CHECK_TTL_MS, error, addresses };
		targetChecks.set(key, hit);
		if (targetChecks.size > 1000)
			for (const [k, v] of targetChecks) if (v.until <= now) targetChecks.delete(k);
	}
	if (hit.error) throw hit.error;
	return hit.addresses;
}

export function parseJson(text: string): any {
	if (!text) {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
