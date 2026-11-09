// A server's restart time: RestartTimeUtc as the worker reads it (in effect apart from a change
// waiting in the file), an owner's own time and who may set it, and the rules that time
// themselves by them.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	auditLog,
	organizations,
	serverLive,
	servers,
	type ServerRow,
	type TriggerRow
} from '$lib/server/db/schema';
import { gateway, setGateway } from '$lib/server/gateway';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { readLiveRows } from '$lib/server/live';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { dryRun, evaluateTriggers, type TickContext } from '$lib/server/triggers';
import { nextUtcAt } from '$lib/uptime';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, stubGateway } from './call';
import { expected } from './policy';
import { PRINCIPALS, seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const H = 3600_000;
const SECTION = '[/Script/WDGame.WDServerLifecycleSubsystem]';
/** "HH:MM" UTC two hours from `now`: a process started ten hours ago is not due by 24 hours up */
const soon = (now: number) => new Date(now + 2 * H).toISOString().slice(11, 16);

/** A look of the rules at a server whose process started at `startedAt`. */
const tick = (
	kind: 'restart_notice' | 'rotation_shuffle',
	server: { restartSchedule: unknown; restartTimeUtc?: string | null },
	startedAt: number,
	now: number
) =>
	evaluateTriggers(
		{} as Env,
		{
			server: { id: 'srv', name: 'Server', restartSchedule: server.restartSchedule },
			restartTimeUtc: server.restartTimeUtc,
			status: { serverName: 'Server', map: 'Kavkazi', playerCount: 10, maxPlayers: 98 },
			players: [],
			startedAt,
			ts: new Date(now)
		} as unknown as TickContext,
		[
			{
				id: 'rule',
				kind,
				name: kind,
				config:
					kind === 'restart_notice'
						? {
								message: 'Restart after this round',
								leadMinutes: 0,
								repeatMinutes: 0,
								minPlayers: 0
							}
						: { maps: [] },
				// a shuffle already made this run, so only a restart coming up shuffles again
				state: kind === 'rotation_shuffle' ? { boot: startedAt, forNext: false, spentBy: 0 } : null
			} as unknown as TriggerRow
		]
	);

describe('the rules on the restart time', () => {
	// started 2026-10-10 08:33 UTC; 08:00 UTC comes 23 h 27 m later
	const started = Date.parse('2026-10-10T08:33:00Z');
	const at = (iso: string) => Date.parse(iso);
	const fired = async (...args: Parameters<typeof tick>) => (await tick(...args)).intents.length;

	test('RestartTimeUtc in effect opens the window at that time UTC, before 24 hours up', async () => {
		const game = { restartSchedule: null, restartTimeUtc: '08:00' };
		for (const kind of ['restart_notice', 'rotation_shuffle'] as const) {
			expect(await fired(kind, game, started, at('2026-10-11T07:59:00Z'))).toBe(0);
			expect(await fired(kind, game, started, at('2026-10-11T08:01:00Z'))).toBe(1);
			// with nothing set, 24 hours up is 08:33
			expect(
				await fired(kind, { restartSchedule: null }, started, at('2026-10-11T08:01:00Z'))
			).toBe(0);
			expect(
				await fired(kind, { restartSchedule: null }, started, at('2026-10-11T08:34:00Z'))
			).toBe(1);
		}
	});

	test("an owner's own time comes before RestartTimeUtc", async () => {
		const own = { restartSchedule: { time: '06:00' }, restartTimeUtc: '08:00' };
		for (const kind of ['restart_notice', 'rotation_shuffle'] as const) {
			expect(await fired(kind, own, started, at('2026-10-11T05:59:00Z'))).toBe(0);
			expect(await fired(kind, own, started, at('2026-10-11T06:01:00Z'))).toBe(1);
		}
	});

	test('a stored value that is not a time falls through to the game', async () => {
		for (const junk of ['06:00', 42, [{ time: '06:00' }], { time: '6am' }, { kind: 'none' }]) {
			const s = { restartSchedule: junk, restartTimeUtc: null };
			expect(await fired('restart_notice', s, started, at('2026-10-11T08:32:00Z'))).toBe(0);
			expect(await fired('restart_notice', s, started, at('2026-10-11T08:34:00Z'))).toBe(1);
		}
	});
});

describe.skipIf(!hasTestDb)('the dry runs on the restart time', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
	});

	const serverRow = async (): Promise<ServerRow> =>
		(await env.db.select().from(servers).where(eq(servers.id, w.server.id)))[0];

	test('both project from the time in effect, and an owner time before it', async () => {
		const now = Date.now();
		const started = new Date(now - 10 * H);
		const time = soon(now);
		await env.db
			.insert(serverLive)
			.values({ serverId: w.server.id, startedAt: started, restartTimeUtc: time });
		const dueAt = new Date(nextUtcAt(started.getTime(), time)).toISOString();

		const shuffle = await dryRun(env, await serverRow(), 'rotation_shuffle', { maps: [] });
		expect(shuffle.items).toEqual([
			{ at: dueAt, text: 'shuffle in the last round, for after the restart' }
		]);
		expect(shuffle.notes[0]).toStartWith(
			`Restarts daily at ${time} UTC, from RestartTimeUtc in the config. Up 10h;`
		);
		const notice = await dryRun(env, await serverRow(), 'restart_notice', {
			message: 'Restarting'
		});
		expect(notice.items.map((i) => i.at)).toEqual([dueAt]);

		// a change only in the file does not count; an owner's own time does
		const own = soon(now + H);
		await env.db
			.update(serverLive)
			.set({ restartTimeUtc: null, restartTimeUtcFile: time })
			.where(eq(serverLive.serverId, w.server.id));
		await env.db
			.update(servers)
			.set({ restartSchedule: { time: own } })
			.where(eq(servers.id, w.server.id));
		const mine = await dryRun(env, await serverRow(), 'restart_notice', { message: 'Restarting' });
		expect(mine.items.map((i) => i.at)).toEqual([
			new Date(nextUtcAt(started.getTime(), own)).toISOString()
		]);
		await env.db.update(servers).set({ restartSchedule: null }).where(eq(servers.id, w.server.id));
		const game = await dryRun(env, await serverRow(), 'restart_notice', { message: 'Restarting' });
		expect(game.items.map((i) => i.at)).toEqual([
			new Date(started.getTime() + 24 * H).toISOString()
		]);
		expect(game.notes.at(-1)).toStartWith('Up 10h;');
	});
});

describe.skipIf(!hasTestDb)('the worker reads RestartTimeUtc', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	/** what the game answers: when its process started, and its config document */
	const game = { startedAt: Date.now() - 5 * H, text: '' };
	const configWith = (time: string | null) =>
		[
			'[/Script/WDGame.WDRCONSettings]',
			'Password=never-leaves',
			...(time ? [SECTION, `RestartTimeUtc=${time}`] : [])
		].join('\r\n');

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'restart-time')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`restart-time-${server.id}`
			);
			const raw = client.raw.bind(client);
			const json = (body: unknown) => ({
				status: 200,
				statusText: 'OK',
				headers: { 'content-type': 'application/json' },
				text: JSON.stringify(body)
			});
			client.raw = async (method, path, body, headers) =>
				method === 'GET' && path === '/v1/health'
					? json({
							status: 'ok',
							uptimeSeconds: Math.floor((Date.now() - game.startedAt) / 1000)
						})
					: method === 'GET' && path === '/v1/config'
						? json({ revision: 'r1', writable: true, text: game.text, sections: [] })
						: raw(method, path, body, headers);
			return client;
		});
	});

	afterAll(async () => {
		spy.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});

	const look = async () => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		await observeServer(env, m, { status: true, players: true });
		return m;
	};
	const row = async () => {
		const [r] = await env.db
			.select({ inEffect: serverLive.restartTimeUtc, file: serverLive.restartTimeUtcFile })
			.from(serverLive)
			.where(eq(serverLive.serverId, w.server.id));
		return r;
	};

	test('in effect from the first read after a start; a change waits for the next restart', async () => {
		game.text = configWith('08:00');
		const m = await look();
		expect(await row()).toEqual({ inEffect: '08:00', file: '08:00' });

		// changed in the file: read hourly, shown as waiting
		game.text = configWith('06:00');
		m.identity.checkedAt = 0;
		await look();
		expect(await row()).toEqual({ inEffect: '08:00', file: '06:00' });

		// the process restarts: the look that sees it asks for a read, the next one takes it
		game.startedAt = Date.now() - 30_000;
		await look();
		expect(m.identity.checkedAt).toBe(0);
		await look();
		expect(await row()).toEqual({ inEffect: '06:00', file: '06:00' });

		// taken out of the file
		game.text = configWith(null);
		m.identity.checkedAt = 0;
		await look();
		expect(await row()).toEqual({ inEffect: '06:00', file: null });
	});

	test('a start that drifts by seconds is no restart: no new read, nothing taken as in effect', async () => {
		game.text = configWith('07:00');
		const m = await look();
		m.identity.checkedAt = 0;
		await look();
		expect(await row()).toEqual({ inEffect: '06:00', file: '07:00' });
		const checked = m.identity.checkedAt;
		for (const drift of [6_000, -6_000]) {
			game.startedAt += drift;
			await look();
			expect(m.identity.checkedAt).toBe(checked);
		}
		await look();
		expect(await row()).toEqual({ inEffect: '06:00', file: '07:00' });
	});

	test('a worker that starts again keeps what it had on record for the same start', async () => {
		game.text = configWith('05:00');
		forgetMemory(w.server.id);
		await look();
		expect(await row()).toEqual({ inEffect: '06:00', file: '05:00' });
	});

	test('with nothing on record, the first read is taken as in effect', async () => {
		await env.db
			.update(serverLive)
			.set({ restartTimeUtc: null, restartTimeUtcFile: null })
			.where(eq(serverLive.serverId, w.server.id));
		forgetMemory(w.server.id);
		await look();
		expect(await row()).toEqual({ inEffect: '05:00', file: '05:00' });
	});

	test('the page reads them through the live view, and nothing else of the document', async () => {
		// the web process's cold read: the rows the worker wrote
		stubGateway();
		setGateway({ ...gateway(), live: (e, ids) => readLiveRows(e, ids) });
		const { load } = await import(join(ROUTES, '(app)', 'server', '[id]', '+layout.server.ts'));
		const page = await callLoad(load, w.users.viewer, { params: { id: w.server.id } });
		const identity = (page.body as { identity: Record<string, unknown> }).identity;
		expect(identity).toMatchObject({ restartTimeUtc: '05:00', restartTimeUtcFile: '05:00' });
		expect(JSON.stringify(page.body)).not.toContain('never-leaves');
		const [live] = await env.db
			.select()
			.from(serverLive)
			.where(eq(serverLive.serverId, w.server.id));
		expect(JSON.stringify(live)).not.toContain('never-leaves');
		stubGateway();
	});
});

describe.skipIf(!hasTestDb)("setting an owner's own restart time", () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
	});

	const handler = async (key: string) => {
		const [method, path] = key.split(' ');
		return (await import(join(ROUTES, path, '+server.ts')))[method];
	};
	const patch = async (w: World, who: PrincipalName, restartSchedule: unknown) =>
		callApi(await handler('PATCH api/servers/[id]'), w.users[who], {
			method: 'PATCH',
			params: { id: w.server.id },
			body: { restartSchedule }
		});
	const stored = async (w: World) =>
		(
			await env.db
				.select({ s: servers.restartSchedule })
				.from(servers)
				.where(eq(servers.id, w.server.id))
		)[0].s;
	/** any JSON at all, as a hand edit of the row could leave it */
	const store = (w: World, value: unknown) =>
		env.db.execute(
			sql`UPDATE servers SET restart_schedule = ${JSON.stringify(value)}::jsonb WHERE id = ${w.server.id}`
		);

	test('only an owner of the org, or the site owner, sets it; nobody else changes it', async () => {
		const w = await seedWorld(env);
		const got: Record<string, unknown> = {};
		const want: Record<string, unknown> = {};
		for (const [i, who] of PRINCIPALS.entries()) {
			const time = { time: `${String(i).padStart(2, '0')}:30` };
			const before = await stored(w);
			const answer = await patch(w, who, time);
			got[who] = [answer.status, await stored(w)];
			const verdict = expected('manager', who);
			want[who] = verdict === 'ok' ? [200, time] : [verdict, before];
		}
		expect(got).toEqual(want);
		// the four the rules name, spelled out: a viewer, a member of another org, a scoped key, nobody
		const status = (who: PrincipalName) => (got[who] as [number, unknown])[0];
		expect((['viewer', 'outsider', 'keyView', 'keyAll', 'anon'] as const).map(status)).toEqual([
			403, 404, 403, 403, 401
		]);
	});

	test('anything but a UTC time from 00:00 to 23:59 is refused and nothing is written', async () => {
		const w = await seedWorld(env);
		await store(w, { time: '12:00' });
		for (const bad of [
			'07:00',
			42,
			[{ time: '07:00' }],
			{},
			{ time: '24:00' },
			{ time: '7:00' },
			{ time: '07:60' },
			{ time: ' 07:00' },
			{ time: 700 },
			{ kind: 'uptime', hours: 12 },
			{ kind: 'daily', time: '07:00 am', timeZone: 'America/Chicago' }
		]) {
			const answer = await patch(w, 'owner', bad);
			expect([answer.status, answer.message]).toEqual([
				400,
				'The restart time is not valid: a UTC time from 00:00 to 23:59.'
			]);
		}
		expect(await stored(w)).toEqual({ time: '12:00' });
	});

	test('what is kept, and what the audit row says', async () => {
		const w = await seedWorld(env);
		expect((await patch(w, 'owner', { time: '00:00', timeZone: 'America/Chicago' })).status).toBe(
			200
		);
		expect(await stored(w)).toEqual({ time: '00:00' });
		const [row] = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.action, 'server.update')))
			.orderBy(desc(auditLog.ts))
			.limit(1);
		expect(row.detail).toEqual({ restartSchedule: { time: '00:00' }, credentialRotated: false });
		expect(JSON.stringify(row)).not.toContain('rcon-password');
		// null hands the restart back to the game
		expect((await patch(w, 'owner', null)).status).toBe(200);
		expect(await stored(w)).toBeNull();
	});

	test('it reaches only those who already see the server, as a time and nothing else', async () => {
		const w = await seedWorld(env);
		await store(w, { time: '07:00', note: 'kept out' });
		const { load } = await import(join(ROUTES, '(app)', 'server', '[id]', '+layout.server.ts'));
		const layout = (who: PrincipalName) =>
			callLoad(load, w.users[who], { params: { id: w.server.id } });
		const own = (o: { body: unknown }) =>
			(o.body as { server: { restartSchedule: unknown } }).server.restartSchedule;
		expect(own(await layout('viewer'))).toEqual({ time: '07:00' });
		expect((await layout('outsider')).status).toBe(404);
		expect((await layout('member')).status).toBe(404);
		expect((await layout('anon')).status).toBe(401);

		const list = async (who: PrincipalName) => {
			const answer = await callApi(await handler('GET api/servers'), w.users[who]);
			return (
				(answer.body as { servers?: { id: string; restartSchedule: unknown }[] }).servers ?? []
			);
		};
		const here = async (who: PrincipalName) =>
			(await list(who)).find((s) => s.id === w.server.id)?.restartSchedule;
		expect(await here('viewer')).toEqual({ time: '07:00' });
		expect(await here('keyView')).toEqual({ time: '07:00' });
		expect(await here('outsider')).toBeUndefined();
		expect(await here('keyElsewhere')).toBeUndefined();
		expect(await here('stranger')).toBeUndefined();

		// junk stored by hand opens the page all the same, with the game deciding
		for (const junk of ['07:00', 42, [{ time: '07:00' }], { time: '25:00' }, { kind: 'none' }]) {
			await store(w, junk);
			const owner = await layout('owner');
			expect(owner.status).toBe(200);
			expect(own(owner)).toBeNull();
		}
	});
});
