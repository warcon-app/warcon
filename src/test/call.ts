// Calls a +server.ts handler or a page load the way SvelteKit would, with `locals` already
// filled in: what hooks.server.ts does (session cookie or bearer to locals.user) is tested on its
// own, and everything after it only ever reads locals.
import type { RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '$lib/server/access';
import { setGateway, type Gateway } from '$lib/server/gateway';
import type { MatchFeed } from '$lib/server/match-feed';
import { resetRates } from '$lib/server/ratelimit';

export interface Outcome {
	status: number;
	code: string;
	message: string;
	body: unknown;
}

export interface CallInput {
	method?: string;
	params?: Record<string, string>;
	query?: string;
	body?: unknown;
	/** the body's text as sent, for one JSON.stringify cannot build (nested past its stack) */
	raw?: string;
}

function eventFor(user: SessionUser | null, input: CallInput): RequestEvent {
	const method = input.method ?? 'GET';
	const url = new URL(`http://localhost:5173/test${input.query ? `?${input.query}` : ''}`);
	const request = new Request(url, {
		method,
		headers: { 'content-type': 'application/json', 'x-requested-with': 'warcon' },
		body: method === 'GET' ? undefined : (input.raw ?? JSON.stringify(input.body ?? {}))
	});
	return {
		locals: { user, session: null, apiKey: user?.apiKey ?? null },
		params: input.params ?? {},
		url,
		request,
		cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		parent: async () => ({}),
		depends: () => {},
		route: { id: '/test' }
	} as unknown as RequestEvent;
}

/** A handler's Response as it is, for answers that are not JSON (a CSV download). */
export async function callRaw(
	handler: (event: RequestEvent) => Response | Promise<Response>,
	user: SessionUser | null,
	input: CallInput = {}
): Promise<Response> {
	resetRates();
	return handler(eventFor(user, input));
}

/** An API handler's answer. Handlers are wrapped in route(), so refusals come back as JSON. */
export async function callApi(
	handler: (event: RequestEvent) => Response | Promise<Response>,
	user: SessionUser | null,
	input: CallInput = {}
): Promise<Outcome> {
	resetRates();
	const res = await handler(eventFor(user, input));
	const type = res.headers.get('content-type') ?? '';
	if (!type.includes('application/json')) {
		await res.body?.cancel().catch(() => {});
		return { status: res.status, code: '', message: '', body: null };
	}
	const body = (await res.json()) as { error?: { code?: string; message?: string } };
	return {
		status: res.status,
		code: body?.error?.code ?? '',
		message: body?.error?.message ?? '',
		body
	};
}

/** A page load's answer: its data, or the error()/redirect() it threw. */
export async function callLoad(
	load: (event: never) => unknown,
	user: SessionUser | null,
	input: CallInput = {}
): Promise<Outcome> {
	resetRates();
	try {
		const body = await load(eventFor(user, input) as never);
		return { status: 200, code: '', message: '', body };
	} catch (err) {
		// error() and redirect() carry a status and a body or location; an ApiError thrown straight
		// out of a load carries a status and its own message.
		const e = err as {
			status?: number;
			location?: string;
			message?: string;
			body?: { message?: string; code?: string };
		};
		if (typeof e?.status !== 'number') throw err;
		return {
			status: e.status,
			code: e.body?.code ?? '',
			message: e.body?.message ?? e.location ?? e.message ?? '',
			body: null
		};
	}
}

/** The worker, answering nothing (or `answer`): permission tests stop at "the request got as far as the game". */
export function stubGateway(answer: unknown = {}): {
	runs: { server: string; action: string }[];
	/** what the kill feed handed the worker about matches */
	fed: { server: string; feed: MatchFeed }[];
} {
	const runs: { server: string; action: string }[] = [];
	const fed: { server: string; feed: MatchFeed }[] = [];
	const g: Gateway = {
		run: async (_env, server, action) => {
			runs.push({ server: server.id, action });
			return structuredClone(answer);
		},
		live: async () => new Map(),
		interest: () => {},
		observeSoon: () => {},
		observeNow: async () => null,
		syncOrg: async () => ({ servers: [] }),
		syncServer: async () => ({ ok: true }) as never,
		settingsChanged: async () => {},
		triggersChanged: () => {},
		identityChanged: () => {},
		statusChanged: () => {},
		killsIngested: () => {},
		matchFeed: (_env, server, feed) => {
			fed.push({ server, feed });
		},
		subscribe: () => () => {},
		health: async () => ({}) as never
	};
	setGateway(g);
	return { runs, fed };
}
