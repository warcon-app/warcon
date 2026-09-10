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
	if (err instanceof GameError)
		return {
			kind: 'game',
			status: err.status,
			message: err.message,
			code: err.code,
			body: err.body
		};
	if (err instanceof ApiError)
		return { kind: 'api', status: err.status, message: err.message, code: err.code };
	return { kind: 'other', status: 500, message: err instanceof Error ? err.message : String(err) };
}
