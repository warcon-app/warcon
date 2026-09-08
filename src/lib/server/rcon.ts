// Server-side client for the WDRCON HTTP API (mirrors rcon.wardogs.com's js/api.js).
import type { Env } from './env';
import { flag } from './env';
import { gameRequest, TransportError, type GameResponse, type GameTarget } from './transport';
import { mockHandle } from './mockgame';
import { decryptSecret } from './crypto';
import type { ServerRow } from './access';

export class GameError extends Error {
	constructor(
		public status: number,
		message: string,
		public code = '',
		public body: any = null
	) {
		super(message);
	}
}

export const DEMO_HOST = 'demo';

export function isDemoServer(env: Env, server: { host: string }): boolean {
	return flag(env.ALLOW_DEMO_SERVER, false) && server.host.trim().toLowerCase() === DEMO_HOST;
}

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
		const key = demo
			? await decryptSecret(env, server.passwordEnc)
			: await decryptSecret(env, server.passwordEnc);
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
			throw new GameError(
				res.status,
				parsed?.error?.message ||
					`Server answered ${res.status}${res.statusText ? ' ' + res.statusText : ''}.`,
				parsed?.error?.code || '',
				parsed
			);
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
