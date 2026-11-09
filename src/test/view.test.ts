// What View is: what is happening on the server. These tests read the answers a viewer gets and
// check that what belongs to another capability is not in them, however the page would have
// drawn it: data sent to the browser is read, shown or not.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { listOf } from '$lib/server/lists';
import {
	listEntries,
	matches,
	matchPlayers,
	playerMarks,
	playerNotes,
	playerSessions,
	serverBans
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const PLAYER = '76561198000000042';

describe.skipIf(!hasTestDb)('what View shows', () => {
	let env: Env;
	let w: World;

	const get = async (who: PrincipalName, path: string, query = '') => {
		const { GET } = await import(join(ROUTES, path, '+server.ts'));
		const answer = await callApi(GET, w.users[who], {
			params: { id: w.server.id, steamId: PLAYER },
			query
		});
		expect({ who, path, status: answer.status }).toEqual({ who, path, status: 200 });
		return answer.body as Record<string, any>;
	};

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		await env.db.insert(playerNotes).values({
			orgId: w.org.id,
			steamId: PLAYER,
			authorId: w.users.admin!.id,
			authorName: 'admin',
			body: 'suspected alt of a banned player'
		});
		await env.db.insert(playerMarks).values({
			orgId: w.org.id,
			steamId: PLAYER,
			watched: true,
			reason: 'watch for team kills',
			updatedByName: 'admin'
		});
		await env.db.insert(serverBans).values({
			serverId: w.otherServer.id,
			steamId: PLAYER,
			reason: 'cheating on the other server',
			bannedBy: 'admin'
		});
		const bans = await listOf(env, w.org.id, 'ban');
		await env.db.insert(listEntries).values({
			id: newId(),
			listId: bans.id,
			steamId: PLAYER,
			reason: 'org-wide ban reason',
			addedByName: 'admin'
		});
		const slots = await listOf(env, w.org.id, 'reserve');
		await env.db.insert(listEntries).values({
			id: newId(),
			listId: slots.id,
			steamId: PLAYER,
			reason: 'sponsor, paid until March',
			addedByName: 'admin'
		});
	});

	test('who holds a reserved slot is View; the note on it needs Reserved slots or Org reserved slots', async () => {
		const slot = async (who: PrincipalName) =>
			(await get(who, 'api/servers/[id]/lists/state')).reserved[PLAYER];
		expect(await slot('viewer')).toMatchObject({ state: 'pending', note: '' });
		expect(await slot('operator')).toMatchObject({ note: '' });
		expect(await slot('orgBans')).toMatchObject({ state: 'pending', note: '' });
		expect(await slot('orgSlots')).toMatchObject({ note: 'sponsor, paid until March' });
		expect(await slot('admin')).toMatchObject({ note: 'sponsor, paid until March' });
		expect(await slot('owner')).toMatchObject({ note: 'sponsor, paid until March' });
	});

	test('the org lists view carries the lists the reader edits; the ban message goes with the ban list', async () => {
		const { GET } = await import(join(ROUTES, 'api/orgs/[id]/lists', '+server.ts'));
		const view = async (who: PrincipalName) => {
			const answer = await callApi(GET, w.users[who], { params: { id: w.org.id } });
			expect({ who, status: answer.status }).toEqual({ who, status: 200 });
			const v = answer.body as Record<string, any>;
			return {
				kinds: v.kinds,
				lists: v.lists.map((l: { kind: string }) => l.kind),
				banMessage: v.banMessage
			};
		};
		expect(await view('orgBans')).toEqual({
			kinds: ['ban'],
			lists: ['ban'],
			banMessage: '{reason}'
		});
		expect(await view('orgSlots')).toEqual({
			kinds: ['reserve'],
			lists: ['reserve'],
			banMessage: null
		});
		expect(await view('owner')).toEqual({
			kinds: ['ban', 'reserve'],
			lists: ['ban', 'reserve'],
			banMessage: '{reason}'
		});
	});

	test('where the server listens and what its owners noted are for its owners', async () => {
		const mine = async (who: PrincipalName) =>
			(await get(who, 'api/servers')).servers.find((s: { id: string }) => s.id === w.server.id);
		for (const who of ['viewer', 'operator', 'admin', 'keyAll'] as const)
			expect({ who, ...pick(await mine(who)) }).toEqual({ who, host: '', port: 0, notes: '' });
		expect(pick(await mine('owner'))).toEqual({
			host: 'game.test.invalid',
			port: 7779,
			notes: 'owner notes'
		});

		stubGateway();
		const { load } = await import(join(ROUTES, '(app)/server/[id]/+layout.server.ts'));
		const page = await callLoad(load, w.users.viewer, { params: { id: w.server.id } });
		expect(pick((page.body as { server: Record<string, unknown> }).server)).toEqual({
			host: '',
			port: 0,
			notes: ''
		});
	});

	test('staff notes and the watch reason need Notes; an org list entry needs that list', async () => {
		const dossier = async (who: PrincipalName) =>
			(await get(who, 'api/servers/[id]/players/[steamId]')).dossier;

		const viewer = await dossier('viewer');
		expect(viewer.notes).toEqual([]);
		expect(viewer.watch).toMatchObject({ watched: true, reason: '', updatedByName: '' });
		expect(viewer.orgLists).toEqual({ reserve: null, canBan: false, canReserve: false });
		expect(viewer.banDialog).toBeNull();
		expect(JSON.stringify(viewer)).not.toContain('suspected alt');
		// Who is banned and why is View, as a server's Bans tab says it; who placed it is not.
		expect(viewer.bans).toEqual([
			expect.objectContaining({
				source: 'org',
				reason: 'org-wide ban reason',
				by: '',
				canUnban: false
			})
		]);

		const operator = await dossier('operator');
		expect(operator.notes.map((n: { body: string }) => n.body)).toEqual([
			'suspected alt of a banned player'
		]);
		expect(operator.watch.reason).toBe('watch for team kills');
		expect(operator.bans.map((b: { by: string }) => b.by)).toEqual(['']);

		const admin = await dossier('admin');
		expect(admin.bans).toEqual([
			expect.objectContaining({ source: 'org', reason: 'org-wide ban reason', by: 'admin' })
		]);
		expect(admin.orgLists.reserve).toMatchObject({ reason: 'sponsor, paid until March' });
		expect(admin.orgLists).toMatchObject({ canBan: true, canReserve: true });

		// one list's editor reads that list's entry and nothing of the other's
		const bans = await dossier('orgBans');
		expect(bans.orgLists).toMatchObject({ reserve: null, canBan: true, canReserve: false });
		expect(bans.bans).toEqual([
			expect.objectContaining({
				source: 'org',
				reason: 'org-wide ban reason',
				by: 'admin',
				canUnban: true
			})
		]);
		expect(JSON.stringify(bans)).not.toContain('sponsor, paid until March');
		const slots = await dossier('orgSlots');
		expect(slots.orgLists).toMatchObject({ canBan: false, canReserve: true });
		expect(slots.orgLists.reserve).toMatchObject({ reason: 'sponsor, paid until March' });
		// the ban's reason as the Bans tab gives every reader; its author stays with the ban list's
		expect(slots.bans).toEqual([
			expect.objectContaining({ source: 'org', reason: 'org-wide ban reason', by: '' })
		]);
		expect(JSON.stringify(slots.bans)).not.toContain('admin');
	});

	test('the risk score counts bans and recorded games only on servers the reader can open', async () => {
		const t = new Date(Date.now() - 3600_000);
		await env.db.insert(playerSessions).values({
			serverId: w.otherServer.id,
			steamId: PLAYER,
			name: 'someone',
			joinedAt: t,
			lastSeen: t,
			leftAt: t
		});
		// a recorded game on the other server: the player's line of a match that ended there
		const [game] = await env.db
			.insert(matches)
			.values({ serverId: w.otherServer.id, startedAt: t, endedAt: new Date(), map: 'Europe' })
			.returning({ id: matches.id });
		await env.db.insert(matchPlayers).values({
			matchId: game.id,
			serverId: w.otherServer.id,
			steamId: PLAYER,
			name: 'someone',
			faction: 'Lonestar',
			seconds: 3600,
			kills: 500,
			deaths: 25
		});
		const seen = async (who: PrincipalName) => {
			const marks = (
				await get(who, 'api/servers/[id]/players/marks', `ids=${PLAYER}&names=someone`)
			).marks;
			const dossier = (await get(who, 'api/servers/[id]/players/[steamId]')).dossier;
			return JSON.stringify([marks[0].risk, dossier.risk]);
		};
		const viewer = await seen('viewer');
		expect(viewer).not.toContain('cheating on the other server');
		expect(viewer).not.toContain(`Banned on ${w.otherServer.id.slice(2)}`);
		// the org's list holds the player on the viewer's server too, so it counts on the page
		expect(viewer).toContain('Banned on every server of the organisation: org-wide ban reason');
		expect(viewer).not.toContain('K/D');
		const owner = await seen('owner');
		expect(owner).toContain('cheating on the other server');
		expect(owner).toContain('20.0 K/D across 500 kills and 25 deaths');
	});

	test("the players table's marks name bans only on servers the reader can open", async () => {
		const marks = async (who: PrincipalName) =>
			JSON.stringify(
				(await get(who, 'api/servers/[id]/players/marks', `ids=${PLAYER}&names=someone`)).marks
			);
		expect(await marks('viewer')).not.toContain('cheating on the other server');
		expect(await marks('viewer')).not.toContain('watch for team kills');
		expect(await marks('operator')).toContain('watch for team kills');
		expect(await marks('owner')).toContain('cheating on the other server');
	});

	test("raw status and the game's raw capabilities need Config & settings", async () => {
		const seen: Record<string, unknown>[] = [];
		const { setGateway } = await import('$lib/server/gateway');
		const base = stubGateway();
		void base;
		const { gateway } = await import('$lib/server/gateway');
		const stub = gateway();
		setGateway({
			...stub,
			run: async (_env, _server, action, params) => {
				seen.push({ action, ...params });
				return action === 'capabilities' ? { routes: [], features: {}, raw: { secret: 1 } } : {};
			}
		});
		const { POST } = await import(join(ROUTES, 'api/servers/[id]/rcon/[action]/+server.ts'));
		const ask = (who: PrincipalName, action: string, body: unknown) =>
			callApi(POST, w.users[who], {
				method: 'POST',
				params: { id: w.server.id, action },
				body
			});
		await ask('viewer', 'status', { raw: true });
		await ask('admin', 'status', { raw: true });
		expect(seen).toEqual([{ action: 'status' }, { action: 'status', raw: true }]);
		const viewer = await ask('viewer', 'capabilities', {});
		const admin = await ask('admin', 'capabilities', {});
		expect((viewer.body as any).result.raw).toBeUndefined();
		expect((admin.body as any).result.raw).toEqual({ secret: 1 });
	});

	test('the event stream tells what a rule did only to those who may read the outbox', async () => {
		let emit: (e: any) => void = () => {};
		const { gateway, setGateway } = await import('$lib/server/gateway');
		stubGateway();
		const stub = gateway();
		setGateway({
			...stub,
			subscribe: (fn) => {
				emit = fn;
				return () => {};
			}
		});
		const { GET } = await import(join(ROUTES, 'api/live/events/+server.ts'));
		const heard = async (who: PrincipalName) => {
			const res: Response = await GET({
				locals: { user: w.users[who], session: null, apiKey: null },
				url: new URL(`http://localhost/api/live/events?ids=${w.server.id}`),
				request: new Request('http://localhost/api/live/events'),
				setHeaders: () => {}
			} as never);
			const reader = res.body!.getReader();
			await new Promise((r) => setTimeout(r, 20)); // the stream subscribes once it has started
			emit({ type: 'outbox', serverId: w.server.id, id: 'row', state: 'sent' });
			emit({ type: 'kills', serverId: w.server.id, kills: [] });
			let text = '';
			while (!text.includes('event: kills'))
				text += new TextDecoder().decode((await reader.read()).value);
			await reader.cancel();
			return text.includes('event: outbox');
		};
		expect(await heard('viewer')).toBe(false);
		expect(await heard('admin')).toBe(true);
	});
});

const pick = (s: Record<string, unknown>) => ({ host: s.host, port: s.port, notes: s.notes });
