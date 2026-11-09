import { json as kitJson, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { isAPIError } from 'better-auth/api';
import { createHmac } from 'node:crypto';

/** Thrown by server modules; API routes turn it into a JSON error response. */
export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		public code = '',
		public extra?: unknown
	) {
		super(message);
	}
}

export const apiJson = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
	kitJson(data, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** Better Auth throws APIError; shape it like ours so routes and pages can treat both alike. */
export function normalizeError(err: unknown): ApiError | null {
	if (err instanceof ApiError) return err;
	if (isAPIError(err)) {
		const body = (err as { body?: { message?: string; code?: string } }).body;
		const status = Number((err as { statusCode?: number }).statusCode) || 400;
		return new ApiError(
			status,
			body?.message || err.message || 'Request failed.',
			body?.code || ''
		);
	}
	return null;
}

/** A failed query's message ends with its parameters: cut from there to the end, whatever they hold. */
function cutParams(text: string): string {
	const at = text.indexOf('\nparams: ');
	return at < 0 ? text : `${text.slice(0, at)}\nparams: (not logged)`;
}

/**
 * An error as it goes to the process log: its stack, and the cause's message. A failed query's
 * message lists its parameters, and for the servers table those are the stored RCON password (as
 * ciphertext) and the address, so the parameters are left out.
 */
export function forLog(err: unknown): unknown {
	// a message passed on by itself (Better Auth logs some that way) is cut the same way
	if (typeof err === 'string') return cutParams(err);
	if (!(err instanceof Error)) return err;
	// A parameter can hold any text, a line like a stack frame among it: the message is cut on its
	// own and the frames put back after it; a stack that does not start with the message is cut to
	// its end, frames and all.
	const head = `${err.name}: ${err.message}`;
	const stack = err.stack ?? '';
	const text = stack.startsWith(head)
		? `${err.name}: ${cutParams(err.message)}${stack.slice(head.length)}`
		: cutParams(stack || err.message);
	const cause = (err as { cause?: unknown }).cause;
	return cause instanceof Error ? `${text}\ncause: ${cause.message}` : text;
}

export function apiError(raw: unknown): Response {
	const err = normalizeError(raw);
	if (err) {
		return apiJson(
			{
				ok: false,
				error: {
					message: err.message,
					code: err.code || undefined,
					...(err.extra ? { extra: err.extra } : {})
				}
			},
			err.status
		);
	}
	console.error('unhandled', forLog(raw));
	return apiJson({ ok: false, error: { message: 'Internal error.', code: 'internal' } }, 500);
}

/**
 * The message a client may see for an error. Our own ApiErrors (including the game server's
 * GameError) and Better Auth's are written for people; anything else (database, network stack,
 * bugs) is logged and replaced with a generic line so internals never reach the browser.
 */
export function publicMessage(err: unknown, fallback = 'Internal error.'): string {
	const known = normalizeError(err);
	if (known) return known.message;
	console.error('unhandled', forLog(err));
	return fallback;
}

/** Wraps a +server.ts handler so thrown ApiErrors become JSON error responses. */
export const route =
	(fn: (event: RequestEvent) => Promise<Response> | Response): RequestHandler =>
	async (event) => {
		try {
			return await fn(event);
		} catch (err) {
			return apiError(err);
		}
	};

export const param = (event: RequestEvent, name: string): string =>
	str((event.params as Record<string, string | undefined>)[name], 200);

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
	const type = req.headers.get('content-type') || '';
	if (!type.includes('application/json'))
		throw new ApiError(415, 'Expected application/json body.');
	try {
		const text = await req.text();
		return (text ? JSON.parse(text) : {}) as T;
	} catch {
		throw new ApiError(400, 'Malformed JSON body.');
	}
}

/** Set by hooks.server.ts on every request (overwriting anything the client sent). */
export const CLIENT_IP_HEADER = 'x-warcon-client-ip';
export const clientIp = (req: Request): string => req.headers.get(CLIENT_IP_HEADER) || '';
/**
 * The client address as a key for a limit that is stored (the login lockout): a keyed hash, so no
 * address is ever written down. The address itself is only ever held in memory, for throttling.
 */
export const addressKey = (req: Request, secret: string): string => {
	const ip = clientIp(req);
	return ip ? createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32) : 'unknown';
};

/**
 * The client address as adapter-node resolved it (socket peer, or the header named by
 * ADDRESS_HEADER with XFF_DEPTH). It throws when ADDRESS_HEADER is set but absent from the
 * request, e.g. a health check that bypasses the proxy; that becomes an empty string.
 */
export function resolveClientIp(socketAddress: () => string): string {
	try {
		return socketAddress();
	} catch {
		return '';
	}
}
export const userAgent = (req: Request): string =>
	(req.headers.get('user-agent') || '').slice(0, 300);
export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();

export function str(value: unknown, max = 500): string {
	return String(value ?? '')
		.trim()
		.slice(0, max);
}

/** An integer clamped to [min, max]; absent (undefined, null, blank) or non-numeric means `fallback`. */
export function int(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
	if (value === undefined || value === null || value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}
