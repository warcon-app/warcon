import { json as kitJson, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { isAPIError } from 'better-auth/api';

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
	const message = raw instanceof Error ? raw.message : String(raw);
	console.error('unhandled', raw);
	return apiJson({ ok: false, error: { message: 'Internal error: ' + message } }, 500);
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

/** Proxy-aware client address: forwarded headers only when TRUST_PROXY is on. */
export function resolveClientIp(
	req: Request,
	socketAddress: () => string,
	trustProxy: boolean
): string {
	if (trustProxy) {
		const fwd =
			req.headers.get('cf-connecting-ip') ||
			req.headers.get('x-real-ip') ||
			req.headers.get('x-forwarded-for')?.split(',')[0].trim();
		if (fwd) return fwd;
	}
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

export function int(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}
