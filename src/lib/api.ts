// Browser-side client for the JSON API. Every mutation carries the CSRF header.
import { goto } from '$app/navigation';

export class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string,
		public data?: unknown
	) {
		super(message);
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = { 'x-requested-with': 'warcon' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	let res: Response;
	try {
		res = await fetch(path, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: 'same-origin',
			cache: 'no-store'
		});
	} catch {
		throw new ApiError('Could not reach the panel. Check your connection.', 0, 'network');
	}
	const text = await res.text();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let data: any = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = null;
		}
	}
	if (res.status === 401 && data?.error?.code === 'unauthenticated') void goto('/sign-in');
	if (data?.error?.code === 'must_change_password') void goto('/account?force=1');
	if (!res.ok || (data && data.ok === false)) {
		throw new ApiError(
			data?.error?.message || `Request failed (${res.status}).`,
			res.status,
			data?.error?.code,
			data
		);
	}
	return data as T;
}

export function qs(params?: object): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries((params || {}) as Record<string, unknown>)) {
		if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
	}
	const s = q.toString();
	return s ? `?${s}` : '';
}

const rconPath = (serverId: string, action: string) =>
	`/api/servers/${encodeURIComponent(serverId)}/rcon/${action}`;

/** Read-only game-server action. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rconGet = <T = any>(serverId: string, action: string, params?: object) =>
	api<{ result: T }>('GET', rconPath(serverId, action) + qs(params)).then((d) => d.result);

/** Mutating game-server action. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rconPost = <T = any>(serverId: string, action: string, params?: object) =>
	api<{ result: T }>('POST', rconPath(serverId, action), params || {}).then((d) => d.result);

export const errorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);
