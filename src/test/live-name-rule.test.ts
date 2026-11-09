// The Live server name rule on the worker's own look, against a scripted game (status, config
// document, its revision, a pinned name, refusals): it writes its name into ServerName and nothing
// else, not again within a minute, a name typed across lines stays on one line of the document, a
// refusal is recorded in a fixed phrase, and switched off or deleted it puts the server's own name
// back. The Config tab is told that the rule keeps the name only by someone who may apply it.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, servers, triggers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, memoryOf, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { invalidateTriggers, listTriggers } from '$lib/server/triggers';
import type { LiveNameState } from '$lib/server/live-name';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, stubGateway } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const SESSION = '[/Script/WDGame.WDGameSession]';
const DOC = [
	'[/Script/WDRCON.WDRCONSettings]',
	'Password=rcon-secret',
	'',
	SESSION,
	'ServerName=Demo Clan #1',
	'MaxReservedSlots=2',
	''
].join('\r\n');

describe.skipIf(!hasTestDb)('Live server name on a live look', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	/** what the scripted game holds and how it answers */
	const game = {
		text: DOC,
		revision: 1,
		scores: [34, 27, 30],
		puts: 0,
		gets: 0,
		pinned: false,
		refuse: 0,
		/** a status older than the document: the name it showed before the last write */
		statusName: null as string | null
	};
	const shownName = () => /^ServerName=(.*)$/m.exec(game.text)?.[1] ?? '';

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'live-name-live')).toBe(true);
		const json = (body: unknown, status = 200) => ({
			status,
			statusText: status === 200 ? 'OK' : 'Refused',
			headers: { 'content-type': 'application/json', etag: `"r${game.revision}"` },
			text: JSON.stringify(body)
		});
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`live-name-${server.id}`
			);
			client.raw = async (method, path, body, headers = {}) => {
				if (method === 'GET' && path === '/v1/players') return json({ players: [], count: 0 });
				if (method === 'GET' && path === '/v1/status')
					return json({
						serverName: game.statusName ?? shownName(),
						map: 'Kavkazi',
						experiences: [],
						players: { current: 0, max: 98 },
						factionScores: ['Valkyra', 'Lonestar', 'Manticore'].map((name, i) => ({
							name,
							colorHex: '#888888',
							score: game.scores[i]
						})),
						rotation: { nowIndex: 0, nextIndex: 1 }
					});
				if (method === 'GET' && path === '/v1/config') {
					game.gets++;
					return json({
						revision: `r${game.revision}`,
						writable: true,
						text: game.text,
						sections: game.pinned
							? [
									{
										section: '/Script/WDGame.WDGameSession',
										appliesWhen: 'applied',
										allowedKeys: ['ServerName'],
										keyOverrides: [
											{
												key: 'ServerName',
												appliesWhen: 'applied',
												writable: false,
												lockedBy: 'RCON_FixedServerName'
											}
										]
									}
								]
							: [],
						warnings: []
					});
				}
				if (method === 'PUT' && path.startsWith('/v1/config')) {
					game.puts++;
					if (game.refuse)
						return json(
							{
								ok: false,
								error: { code: 'invalid', message: 'Password=rcon-secret is not allowed here' }
							},
							game.refuse
						);
					if (headers['If-Match'] !== `"r${game.revision}"`)
						return json({ ok: false, error: { code: 'revision_mismatch', message: 'no' } }, 412);
					game.text = body ?? '';
					game.revision++;
					return json({ ok: true, revision: `r${game.revision}`, outcomes: [] });
				}
				return json({ ok: false, error: { code: 'no_route', message: 'No such endpoint.' } }, 404);
			};
			return client;
		});
	});

	afterAll(async () => {
		spy.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});

	const route = async (method: string, path: string) =>
		(await import(join(ROUTES, path, '+server.ts')))[method];
	const look = async () => {
		invalidateTriggers(w.server.id);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		await observeServer(env, memoryFor(server, org), { status: true, players: true });
	};
	/** a minute on, as far as the rule's memory goes */
	const aMinuteOn = () => {
		const mem = memoryOf(w.server.id)?.liveName;
		if (mem) mem.attemptAt -= 61_000;
	};
	let ruleId = '';
	const save = async (body: Record<string, unknown>) => {
		const res = ruleId
			? await callApi(
					await route('PATCH', 'api/servers/[id]/triggers/[triggerId]'),
					w.users.owner,
					{
						method: 'PATCH',
						params: { id: w.server.id, triggerId: ruleId },
						body
					}
				)
			: await callApi(await route('POST', 'api/servers/[id]/triggers'), w.users.owner, {
					method: 'POST',
					params: { id: w.server.id },
					body: { kind: 'live_name', name: 'Live server name', enabled: true, ...body }
				});
		expect(res.status).toBeLessThan(300);
		ruleId ||= (res.body as { trigger: { id: string } }).trigger.id;
	};
	const state = async () =>
		(await env.db.select().from(triggers).where(eq(triggers.id, ruleId)))[0].state as LiveNameState;
	const fresh = async () => {
		if (ruleId) await env.db.delete(triggers).where(eq(triggers.id, ruleId));
		ruleId = '';
		forgetMemory(w.server.id);
		Object.assign(game, {
			text: DOC,
			revision: 1,
			puts: 0,
			gets: 0,
			pinned: false,
			refuse: 0,
			statusName: null
		});
		game.scores = [34, 27, 30];
	};

	test('on: its name in ServerName and nothing else, not again within a minute, again once the score moves', async () => {
		await fresh();
		await save({ config: { base: 'Demo Clan #1 | Infantry Only', append: '| {scoreline}' } });
		await look();
		expect(shownName()).toBe('Demo Clan #1 | Infantry Only | 34-27-30');
		expect(game.text).toBe(DOC.replace('ServerName=Demo Clan #1', `ServerName=${shownName()}`));
		expect(await state()).toMatchObject({
			name: 'Demo Clan #1 | Infantry Only | 34-27-30',
			refused: '',
			restored: false
		});
		const view = (await listTriggers(env, w.server.id)).find((t) => t.id === ruleId);
		expect(view?.liveName?.name).toBe('Demo Clan #1 | Infantry Only | 34-27-30');
		// the score moves within the minute: nothing yet
		game.scores = [35, 27, 30];
		await look();
		expect(game.puts).toBe(1);
		aMinuteOn();
		await look();
		expect(game.puts).toBe(2);
		expect(shownName()).toBe('Demo Clan #1 | Infantry Only | 35-27-30');
		// nothing changed: nothing written, however long it has been
		aMinuteOn();
		await look();
		expect(game.puts).toBe(2);
	});

	test('a name typed across lines stays on one line of the document', async () => {
		await fresh();
		await save({
			config: {
				base: 'Demo\r\n[/Script/WDRCON.WDRCONSettings]\r\nPassword=stolen',
				append: '|\n{scoreline}'
			}
		});
		await look();
		const lines = game.text.split('\r\n');
		expect(lines).toHaveLength(DOC.split('\r\n').length);
		expect(lines.filter((l) => l.startsWith('Password='))).toEqual(['Password=rcon-secret']);
		expect(lines.filter((l) => l.startsWith('['))).toEqual([
			'[/Script/WDRCON.WDRCONSettings]',
			SESSION
		]);
		expect(shownName()).toBe('Demo  [/Script/WDRCON.WDRCONSettings]  Password=stolen | 34-27-30');
	});

	test('a pinned name is not written; the row says why in a fixed phrase', async () => {
		await fresh();
		game.pinned = true;
		await save({ config: { base: 'Demo Clan #1' } });
		await look();
		expect(game.puts).toBe(0);
		expect(shownName()).toBe('Demo Clan #1');
		expect((await state()).refused).toBe(
			"ServerName is pinned by a launch argument on this server's command line, so the panel cannot change it."
		);
		// not read again every minute while it stays pinned, but every ten
		const gets = game.gets;
		aMinuteOn();
		await look();
		expect(game.gets).toBe(gets);
		const mem = memoryOf(w.server.id)!.liveName!;
		mem.attemptAt -= 10 * 60_000;
		await look();
		expect(game.gets).toBe(gets + 1);
	});

	test("a refusal is recorded once, in the panel's words, never the game's", async () => {
		await fresh();
		game.refuse = 400;
		await save({ config: { base: 'Demo Clan #1' } });
		await look();
		const s = await state();
		expect(s.refused).toBe('Refused by the server (400, invalid).');
		expect(JSON.stringify(s)).not.toContain('rcon-secret');
		const since = s.since;
		aMinuteOn();
		await look();
		expect(game.puts).toBe(2);
		expect((await state()).since).toBe(since);
		// written once the server takes it
		game.refuse = 0;
		aMinuteOn();
		await look();
		expect(await state()).toMatchObject({ name: 'Demo Clan #1 | 34-27-30', refused: '' });
	});

	test("switched off, then deleted: the server's own name goes back", async () => {
		await fresh();
		await save({ config: { base: 'Demo Clan #1' } });
		await look();
		expect(shownName()).toBe('Demo Clan #1 | 34-27-30');
		await save({ enabled: false });
		// within the minute of its last write, not yet
		await look();
		expect(shownName()).toBe('Demo Clan #1 | 34-27-30');
		aMinuteOn();
		await look();
		expect(shownName()).toBe('Demo Clan #1');
		expect(await state()).toMatchObject({ name: 'Demo Clan #1', restored: true });
		expect(memoryOf(w.server.id)?.liveName).toBeNull();
		// on again: written at once
		await save({ enabled: true });
		await look();
		expect(shownName()).toBe('Demo Clan #1 | 34-27-30');
		const del = await callApi(
			await route('DELETE', 'api/servers/[id]/triggers/[triggerId]'),
			w.users.owner,
			{ method: 'DELETE', params: { id: w.server.id, triggerId: ruleId } }
		);
		expect(del.status).toBeLessThan(300);
		ruleId = '';
		aMinuteOn();
		await look();
		expect(shownName()).toBe('Demo Clan #1');
		const puts = game.puts;
		await look();
		expect(game.puts).toBe(puts);
	});

	test('switched off, a name someone set since stands', async () => {
		await fresh();
		await save({ config: { base: 'Demo Clan #1' } });
		await look();
		expect(shownName()).toBe('Demo Clan #1 | 34-27-30');
		await save({ enabled: false });
		// renamed on the Config tab, which the rule no longer locks
		game.text = game.text.replace(/^ServerName=.*$/m, 'ServerName=Brand New Name');
		game.revision++;
		aMinuteOn();
		await look();
		expect(shownName()).toBe('Brand New Name');
		expect(memoryOf(w.server.id)?.liveName).toBeNull();
		aMinuteOn();
		await look();
		expect(shownName()).toBe('Brand New Name');
	});

	test('switched off before the status showed its write: put back from what the document holds', async () => {
		await fresh();
		await save({ config: { base: 'Demo Clan #1' } });
		await look();
		expect(shownName()).toBe('Demo Clan #1 | 34-27-30');
		// the look's status still shows the name from before the write
		game.statusName = 'Demo Clan #1';
		await save({ enabled: false });
		aMinuteOn();
		await look();
		expect(shownName()).toBe('Demo Clan #1');
		expect(await state()).toMatchObject({ name: 'Demo Clan #1', restored: true });
	});

	test('a name written in quotes is put back all the same', async () => {
		await fresh();
		await save({ config: { base: '"Demo', append: '| {scoreline}"' } });
		await look();
		expect(game.text).toContain('ServerName="Demo | 34-27-30"');
		await save({ enabled: false });
		aMinuteOn();
		await look();
		expect(game.text).toContain('ServerName="Demo\r\n');
	});

	test('the Config tab is told the rule keeps the name only by someone who may apply the document', async () => {
		await fresh();
		const { load } = await import(
			join(ROUTES, '(app)', 'server', '[id]', 'config', '+page.server.ts')
		);
		const told = async (who: 'owner' | 'admin' | 'operator' | 'viewer') => {
			const got = await callLoad(load, w.users[who], { params: { id: w.server.id } });
			expect(got.status).toBe(200);
			return (got.body as { liveName: boolean }).liveName;
		};
		expect(await told('owner')).toBe(false);
		await save({ config: { base: 'Demo Clan #1' } });
		expect(await told('owner')).toBe(true);
		expect(await told('admin')).toBe(true);
		expect(await told('viewer')).toBe(false);
		expect(await told('operator')).toBe(false);
	});
});
