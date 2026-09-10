// The relay protocol between a web process and the worker: plain HTTP + JSON on the worker's
// port, a shared bearer secret, and one server-sent event stream the web keeps open. The same
// routes served by the worker (worker/runtime.ts) and called by gateway-remote.ts.
import { GameError } from './rcon';
import { ApiError } from './http';

export const RELAY_PREFIX = '/relay';

/** How a thrown error crosses the wire, so the web can rethrow the same class. */
export interface RelayError {
	kind: 'game' | 'api' | 'other';
	status: number;
	message: string;
	code?: string;
	body?: unknown;
}

export function serializeError(err: unknown): RelayError {
	const e = err as Partial<GameError> & { name?: string };
	if (err instanceof Error && err.name === 'GameError')
		return {
			kind: 'game',
			status: e.status ?? 502,
			message: err.message,
			code: e.code,
			body: e.body
		};
	if (err instanceof Error && err.name === 'ApiError')
		return { kind: 'api', status: e.status ?? 500, message: err.message, code: e.code };
	return { kind: 'other', status: 500, message: err instanceof Error ? err.message : String(err) };
}
