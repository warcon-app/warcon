// Server-side client for the WDRCON HTTP API (mirrors rcon.wardogs.com's js/api.js).
import type { Env } from './env';
import { flag, isDemoServer } from './env';
import { gameRequest, TransportError, type GameResponse, type GameTarget } from './transport';
import { mockHandle } from './mockgame';
import { decryptSecret } from './crypto';
import { ApiError } from './http';
import { assertReachableTarget } from './hostpolicy';
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
	parsed: any
): GameError {
	const code = parsed?.error?.code || '';
	const message = parsed?.error?.message || '';
	const route = `${method.toUpperCase()} ${path.split('?')[0]}`;
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
	constructor(
		status: number,
		message: string,
		code = '',
		public body: any = null
	) {
		super(status, message, code);
	}
}

export { DEMO_HOST, isDemoServer } from './env';

export class WardogsClient {
	private target: GameTarget;
	constructor(
		private env: Env,
		server: Pick<ServerRow, 'host' | 'port' | 'scheme'>,
		private key: string,
		private demoKey: string | null,
		private timeoutMs = 10000
	) {
		this.target = { host: server.host, port: server.port, scheme: server.scheme };
	}

	static async forServer(env: Env, server: ServerRow): Promise<WardogsClient> {
		const demo = isDemoServer(env, server);
		if (!demo) await assertTargetStillAllowed(server);
		const key = decryptSecret(env, server.passwordEnc);
		return new WardogsClient(env, server, key, demo ? server.id : null);
	}

	async raw(
		method: string,
		path: string,
		body?: string,
		headers: Record<string, string> = {}
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
				timeoutMs: this.timeoutMs,
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
	async json<T = any>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {};
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		const res = await this.raw(
			method,
			path,
			body === undefined ? undefined : JSON.stringify(body),
			headers
		);
		const parsed = parseJson(res.text);
		if (res.status < 200 || res.status >= 300) {
			throw classifyGameError(method, path, res.status, res.statusText, parsed);
		}
		return (parsed ?? {}) as T;
	}

	// text/plain config document routes (POST /v1/config/validate, PUT /v1/config).
	async configCall(
		method: string,
		path: string,
		text: string,
		revision?: string
	): Promise<{ status: number; body: any }> {
		const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
		if (revision) {
			headers['If-Match'] = `"${revision}"`;
		}
		const res = await this.raw(method, path, text, headers);
		return { status: res.status, body: parseJson(res.text) ?? {} };
	}
}

/** How long one verdict on a host is reused before it is resolved again. */
const TARGET_CHECK_TTL_MS = 60_000;
const targetChecks = new Map<string, { until: number; error: GameError | null }>();

/**
 * Re-runs the hostpolicy check right before Warcon talks to a server, so a hostname that was
 * public when it was saved but now points somewhere internal is refused (rebinding). Servers the
 * site owner saved keep their private-address allowance. Cached briefly per host+allowance so the
 * poller does not resolve every server on every tick.
 */
async function assertTargetStillAllowed(
	server: Pick<ServerRow, 'host' | 'allowPrivate'>
): Promise<void> {
	const key = `${server.allowPrivate ? 'p' : 'o'}:${server.host}`;
	const now = Date.now();
	let hit = targetChecks.get(key);
	if (!hit || hit.until <= now) {
		let error: GameError | null = null;
		try {
			await assertReachableTarget(server.host, server.allowPrivate);
		} catch (err) {
			if (!(err instanceof ApiError)) throw err;
			error = new GameError(err.status, err.message, err.code || 'blocked_host');
		}
		hit = { until: now + TARGET_CHECK_TTL_MS, error };
		targetChecks.set(key, hit);
		if (targetChecks.size > 1000)
			for (const [k, v] of targetChecks) if (v.until <= now) targetChecks.delete(k);
	}
	if (hit.error) throw hit.error;
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
