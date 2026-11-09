// The fleet form of the live routes. A page listing a whole fleet names it by org instead of
// listing every id (hundreds do not fit in a URL), reads it slim and streams it passively. The org
// in the query is an id like any other: it narrows the servers the caller may see, never widens them.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { serverLive } from '$lib/server/db/schema';
import { gateway, setGateway } from '$lib/server/gateway';
import type { LiveView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');

const viewOf = (serverId: string): LiveView => ({
	serverId,
	ok: true,
	error: '',
	tier: 'hot',
	build: '',
	gameServerId: '',
	startedAt: null,
	reservedSlots: null,
	matchState: { state: 'MatchState.Playing.KOTH', map: 'Kavkazi', at: '2026-10-15T12:00:00Z' },
	throttledUntil: null,
	status: null,
	players: [{ steamId: '76561198000000042', name: 'someone' } as LiveView['players'][number]],
	statusAt: null,
	playersAt: null,
	observedAt: null
});

describe.skipIf(!hasTestDb)('fleet live reads', () => {
	let env: Env;
	let w: World;
	const interest: string[][] = [];
	let emit: (e: unknown) => void = () => {};

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
		setGateway({
			...gateway(),
			live: async (_env, ids) => new Map(ids.map((id) => [id, viewOf(id)])),
			interest: (ids) => void interest.push(ids),
			subscribe: (fn) => {
				emit = fn as (e: unknown) => void;
				return () => {};
			}
		});
	});

	const read = async (who: PrincipalName, query: string) => {
		const { GET } = await import(join(ROUTES, 'api/live/+server.ts'));
		const answer = await callApi(GET, w.users[who], { query });
		return {
			status: answer.status,
			ids: Object.keys(((answer.body as { live?: object }) ?? {}).live ?? {}).sort(),
			views: Object.values(((answer.body as { live?: object }) ?? {}).live ?? {}) as LiveView[]
		};
	};

	test('org names the servers the caller may see in it, and nothing past them', async () => {
		const ours = [w.server.id, w.otherServer.id].sort();
		const cases: [PrincipalName, string, string[]][] = [
			['viewer', `org=${w.org.id}`, [w.server.id]],
			['viewer', `org=${w.otherOrg.id}`, []],
			['elsewhere', `org=${w.org.id}`, [w.otherServer.id]],
			['owner', `org=${w.org.id}`, ours],
			['owner', `org=${w.otherOrg.id}`, []],
			['outsider', `org=${w.org.id}`, []],
			['outsider', `org=${w.otherOrg.id}`, [w.otherOrgServer.id]],
			['stranger', `org=${w.org.id}`, []],
			['site', `org=${w.otherOrg.id}`, [w.otherOrgServer.id]],
			['keyView', `org=${w.org.id}`, ours],
			['keyView', `org=${w.otherOrg.id}`, []],
			['keyElsewhere', `org=${w.org.id}`, [w.otherServer.id]],
			// ids of another tenant's server stay out, whatever org is named beside them
			['viewer', `org=${w.org.id}&ids=${w.otherOrgServer.id}`, []],
			['outsider', `org=${w.otherOrg.id}&ids=${w.server.id}`, []]
		];
		for (const [who, query, want] of cases)
			expect({ who, query, ...(await read(who, query)) }).toMatchObject({
				who,
				query,
				status: 200,
				ids: want
			});
		expect((await read('anon', `org=${w.org.id}`)).status).toBe(401);
	});

	test("the feed's match state goes with the view of a server the caller may see, to nobody else", async () => {
		const states = async (who: PrincipalName) => {
			const r = await read(who, `ids=${w.server.id}`);
			return r.status === 200 ? r.views.map((v) => v.matchState?.state ?? null) : r.status;
		};
		const playing = ['MatchState.Playing.KOTH'];
		for (const who of ['viewer', 'owner', 'site', 'keyView', 'keyAll'] as const)
			expect({ who, got: await states(who) }).toEqual({ who, got: playing });
		// another org's owner, someone with no org, a key and a member scoped to the other server
		for (const who of ['outsider', 'stranger', 'keyElsewhere', 'elsewhere'] as const)
			expect({ who, got: await states(who) }).toEqual({ who, got: [] });
		expect(await states('anon')).toBe(401);
	});

	test('slim leaves the player lists out', async () => {
		const full = await read('owner', `org=${w.org.id}`);
		const slim = await read('owner', `org=${w.org.id}&slim=1`);
		expect(full.views.every((v) => v.players.length === 1)).toBe(true);
		expect(slim.views.length).toBe(2);
		expect(slim.views.every((v) => v.players.length === 0)).toBe(true);
	});

	const stream = async (who: PrincipalName, query: string) => {
		const { GET } = await import(join(ROUTES, 'api/live/events/+server.ts'));
		return (await GET({
			locals: { user: w.users[who], session: null, apiKey: null },
			url: new URL(`http://localhost/api/live/events?${query}`),
			request: new Request('http://localhost/api/live/events'),
			setHeaders: () => {}
		} as never)) as Response;
	};

	/** What the stream sends while the worker reports a live view, a kill batch and a delivery. */
	const heard = async (who: PrincipalName, query: string) => {
		const res = await stream(who, query);
		const reader = res.body!.getReader();
		await new Promise((r) => setTimeout(r, 20)); // the stream subscribes once it has started
		emit({ type: 'kills', serverId: w.server.id, kills: [] });
		emit({ type: 'outbox', serverId: w.server.id, id: 'row', state: 'sent' });
		emit({ type: 'live', live: viewOf(w.server.id) });
		emit({ type: 'live', live: { ...viewOf(w.server.id), error: 'last' } });
		let text = '';
		while (!text.includes('"error":"last"'))
			text += new TextDecoder().decode((await reader.read()).value);
		await reader.cancel();
		return text;
	};

	test('a passive stream leaves its servers to their own cadence; a plain one makes them watched', async () => {
		interest.length = 0;
		await heard('owner', `org=${w.org.id}&passive=1`);
		expect(interest).toEqual([]);
		await heard('owner', `ids=${w.server.id}`);
		expect(interest).toEqual([[w.server.id]]);
	});

	test('a slim stream carries the views without players, and no kills or deliveries', async () => {
		const slim = await heard('owner', `org=${w.org.id}&passive=1&slim=1`);
		expect(slim).toContain('event: live');
		expect(slim).not.toContain('event: kills');
		expect(slim).not.toContain('event: outbox');
		expect(slim).not.toContain('76561198000000042');
		const plain = await heard('owner', `org=${w.org.id}&passive=1`);
		expect(plain).toContain('event: kills');
		expect(plain).toContain('76561198000000042');
	});

	test('a stream for an org the caller has nothing in is refused like an empty list', async () => {
		const res = await stream('viewer', `org=${w.otherOrg.id}&passive=1`);
		expect(res.status).toBe(400);
		await res.body?.cancel();
	});

	test('the worker answers a list of servers sent in the body as it does one in the URL', async () => {
		const { relay } = await import('../worker/runtime');
		await env.db
			.insert(serverLive)
			.values([
				{ serverId: w.server.id, ok: true, tier: 'hot' },
				{ serverId: w.otherServer.id, ok: false, tier: 'offline' }
			])
			.onConflictDoNothing();
		const ids = [w.server.id, w.otherServer.id];
		const keys = async (res: Response) =>
			Object.keys(((await res.json()) as { result: object }).result).sort();
		const inBody = await relay(
			env,
			'/live',
			new URL('http://worker/relay/live'),
			new Request('http://worker/relay/live', { method: 'POST', body: JSON.stringify({ ids }) })
		);
		const inUrl = await relay(
			env,
			'/live',
			new URL(`http://worker/relay/live?ids=${ids.join(',')}`),
			new Request('http://worker/relay/live')
		);
		expect(await keys(inBody)).toEqual([...ids].sort());
		expect(await keys(inUrl)).toEqual([...ids].sort());
	});
});
