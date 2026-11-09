// An announcement: one message broadcast on several of an org's servers at once. It goes where it
// is sent and nowhere else, only where the caller may chat, all or nothing on a refusal, with a
// trail row on each server as a single broadcast leaves; one server's failure does not stop the
// rest, and what the answer and the trail say never carries a runtime error's text.
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { ServerSummary, SessionUser } from '$lib/server/access';
import { ApiError } from '$lib/server/http';
import { GameError } from '$lib/server/rcon';
import { gateway, setGateway } from '$lib/server/gateway';
import { announce, ANNOUNCE_MAX } from '$lib/server/announce';
import { ACTIONS_PER_MINUTE, actionBudget } from '$lib/server/rcon-run';
import { resetRates, takeRate } from '$lib/server/ratelimit';
import { auditLog, organizations, serverGrants } from '$lib/server/db/schema';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, suspend, type PrincipalName, type World } from './world';

const ROUTE = join(
	import.meta.dir,
	'..',
	'routes',
	'api',
	'orgs',
	'[id]',
	'broadcast',
	'+server.ts'
);
const MESSAGE = 'Event night on every server at 20:00.';

interface Sent {
	server: string;
	action: string;
	params: Record<string, unknown>;
}

/** The worker, taking every broadcast unless `refuse` says otherwise for a server. */
function recordingGateway(refuse: (serverId: string) => unknown = () => null): Sent[] {
	stubGateway();
	const base = gateway();
	const sent: Sent[] = [];
	setGateway({
		...base,
		run: async (_env, server, action, params) => {
			const failure = refuse(server.id);
			if (failure) throw failure;
			sent.push({ server: server.id, action, params: { ...params } });
			return { message: 'Announcement sent to 13 player(s).' };
		}
	});
	return sent;
}

describe.skipIf(!hasTestDb)('an announcement', () => {
	let env: Env;
	let w: World;
	const as = (who: PrincipalName | SessionUser) => (typeof who === 'string' ? w.users[who] : who);

	const post = async (who: PrincipalName | SessionUser, body: unknown, orgId = w.org.id) => {
		const { POST } = await import(ROUTE);
		return callApi(POST, as(who), { method: 'POST', params: { id: orgId }, body });
	};
	/** this world's broadcast rows (every test seeds its own servers; the trail is shared) */
	const rowsFor = async (message: string) =>
		env.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, 'rcon.broadcast'),
					eq(auditLog.target, message),
					inArray(auditLog.serverId, [w.server.id, w.otherServer.id, w.otherOrgServer.id])
				)
			);
	type Answer = {
		ok: boolean;
		sent: number;
		failed: number;
		results: {
			serverId: string;
			serverName: string;
			ok: boolean;
			message: string;
			code?: string;
		}[];
	};

	beforeAll(async () => {
		env = await testEnv();
	});
	beforeEach(async () => {
		w = await seedWorld(env);
	});

	test('goes to each server named, with a trail row on each', async () => {
		const sent = recordingGateway();
		const answer = await post('owner', {
			message: MESSAGE,
			serverIds: [w.server.id, w.otherServer.id]
		});
		expect(answer.status).toBe(200);
		const body = answer.body as Answer;
		expect(body).toMatchObject({ ok: true, sent: 2, failed: 0 });
		expect(body.results.map((r) => [r.serverId, r.ok, r.message]).sort()).toEqual(
			[
				[w.server.id, true, 'Announcement sent to 13 player(s).'],
				[w.otherServer.id, true, 'Announcement sent to 13 player(s).']
			].sort()
		);
		expect(sent.map((s) => [s.server, s.action, s.params]).sort()).toEqual(
			[
				[w.server.id, 'broadcast', { message: MESSAGE }],
				[w.otherServer.id, 'broadcast', { message: MESSAGE }]
			].sort()
		);
		const rows = await rowsFor(MESSAGE);
		expect(rows.map((r) => r.serverId).sort()).toEqual([w.server.id, w.otherServer.id].sort());
		for (const r of rows)
			expect(r).toMatchObject({
				actorId: w.users.owner!.id,
				orgId: w.org.id,
				category: 'rcon',
				outcome: 'ok',
				status: 200,
				message: 'Announcement sent to 13 player(s).'
			});
		// one id on both rows, so a search of the trail finds where it went
		const ids = rows.map((r) => (r.detail as { announcement: { id: string } }).announcement.id);
		expect(new Set(ids).size).toBe(1);
		expect(rows[0].detail).toEqual({ message: MESSAGE, announcement: { id: ids[0] } });
	});

	test('a trail reader on one server sees its row and nothing of the others, not even how many', async () => {
		recordingGateway();
		expect((await post('owner', { message: MESSAGE, serverIds: null })).status).toBe(200);
		const { GET } = await import(
			join(import.meta.dir, '..', 'routes', 'api', 'audit', '+server.ts')
		);
		// the admin role holds Audit trail on the server under test, and nothing on the other one
		const answer = await callApi(GET, w.users.admin, {
			query: `action=rcon.broadcast&limit=500&q=${encodeURIComponent(MESSAGE)}`
		});
		const seen = (
			answer.body as { entries: { serverId: string; detail: unknown }[] }
		).entries.filter((e) => e.serverId === w.server.id || e.serverId === w.otherServer.id);
		expect(seen.map((e) => e.serverId)).toEqual([w.server.id]);
		expect(seen[0].detail).toEqual({ message: MESSAGE, announcement: { id: expect.any(String) } });
	});

	test('null means every server of the org the caller may chat on, and no other', async () => {
		const cases: [PrincipalName, string[]][] = [
			['owner', [w.server.id, w.otherServer.id]],
			['site', [w.server.id, w.otherServer.id]],
			['keyAll', [w.server.id, w.otherServer.id]],
			['operator', [w.server.id]],
			['admin', [w.server.id]],
			['elsewhere', [w.otherServer.id]],
			['keyElsewhere', [w.otherServer.id]]
		];
		for (const [who, want] of cases) {
			const sent = recordingGateway();
			const answer = await post(who, { message: `${MESSAGE} (${who})`, serverIds: null });
			expect({ who, status: answer.status }).toEqual({ who, status: 200 });
			expect({ who, to: sent.map((s) => s.server).sort() }).toEqual({ who, to: [...want].sort() });
		}
		// never another org's server, whoever asks
		const sent = recordingGateway();
		await post('site', { message: MESSAGE, serverIds: null });
		expect(sent.map((s) => s.server)).not.toContain(w.otherOrgServer.id);
	});

	test('a server named without Chat on it sends nothing, and its trail shows the refusal', async () => {
		// the operator also sees the other server, as a viewer
		await env.db.insert(serverGrants).values({
			serverId: w.otherServer.id,
			userId: w.users.operator!.id,
			roleId: w.roles.viewer
		});
		const sent = recordingGateway();
		const answer = await post('operator', {
			message: MESSAGE,
			serverIds: [w.server.id, w.otherServer.id]
		});
		expect(answer.status).toBe(403);
		expect(answer.code).toBe('forbidden');
		expect(sent).toEqual([]);
		const rows = await rowsFor(MESSAGE);
		expect(rows.map((r) => [r.serverId, r.outcome, r.status])).toEqual([
			[w.otherServer.id, 'denied', 403]
		]);
		// what the caller may do still goes, once asked for alone
		expect((await post('operator', { message: MESSAGE, serverIds: [w.server.id] })).status).toBe(
			200
		);
		expect(sent.map((s) => s.server)).toEqual([w.server.id]);
		// and "every server" passes over the one they only view
		sent.length = 0;
		expect((await post('operator', { message: `${MESSAGE} (all)`, serverIds: null })).status).toBe(
			200
		);
		expect(sent.map((s) => s.server)).toEqual([w.server.id]);
	});

	test('a server the caller cannot see answers as one that does not exist', async () => {
		const sent = recordingGateway();
		const cases: [PrincipalName, string[]][] = [
			['operator', [w.server.id, w.otherServer.id]], // not shared with them
			['operator', [w.server.id, w.otherOrgServer.id]], // another org's
			['operator', [w.server.id, 'no-such-server']],
			['owner', [w.otherOrgServer.id]],
			['keyElsewhere', [w.server.id]], // outside the key's servers
			['elsewhere', [w.server.id]]
		];
		for (const [who, serverIds] of cases) {
			const answer = await post(who, { message: MESSAGE, serverIds });
			expect({ who, serverIds, status: answer.status, message: answer.message }).toEqual({
				who,
				serverIds,
				status: 404,
				message: 'Server not found.'
			});
		}
		expect(sent).toEqual([]);
		expect(await rowsFor(MESSAGE)).toEqual([]);
	});

	test('nobody without Chat in the org gets past the door, and outsiders do not see it', async () => {
		const sent = recordingGateway();
		const body = { message: MESSAGE, serverIds: null };
		for (const who of ['viewer', 'orgBans', 'orgSlots', 'keyView', 'keyBans'] as PrincipalName[])
			expect({ who, status: (await post(who, body)).status }).toEqual({ who, status: 403 });
		for (const who of ['stranger', 'outsider', 'member'] as PrincipalName[])
			expect({ who, status: (await post(who, body)).status }).toEqual({ who, status: 404 });
		expect((await post('anon', body)).status).toBe(401);
		// another org's owner, at this org's address
		expect((await post('outsider', { message: MESSAGE, serverIds: [w.server.id] })).status).toBe(
			404
		);
		expect(sent).toEqual([]);
	});

	test('a request that does not say what or where sends nothing', async () => {
		const sent = recordingGateway();
		for (const body of [
			{ message: MESSAGE },
			{ message: MESSAGE, serverIds: [] },
			{ message: MESSAGE, serverIds: 'all' },
			{ message: MESSAGE, serverIds: [1, 2] },
			{ message: MESSAGE, serverIds: [''] },
			{ message: '', serverIds: null },
			{ message: '   ', serverIds: [w.server.id] },
			{ serverIds: null }
		]) {
			const answer = await post('owner', body);
			expect({ body, status: answer.status }).toEqual({ body, status: 400 });
		}
		expect(sent).toEqual([]);
	});

	test('a long message is cut where a single broadcast cuts it', async () => {
		const sent = recordingGateway();
		const long = 'x'.repeat(300);
		expect((await post('owner', { message: long, serverIds: [w.server.id] })).status).toBe(200);
		expect(sent[0].params).toEqual({ message: 'x'.repeat(256) });
	});

	test("one server's refusal does not stop the rest, and says why", async () => {
		const sent = recordingGateway((id) =>
			id === w.otherServer.id
				? new GameError(502, 'Could not reach the game server (timed out).', 'unreachable')
				: null
		);
		const answer = await post('owner', {
			message: MESSAGE,
			serverIds: [w.server.id, w.otherServer.id]
		});
		expect(answer.status).toBe(200);
		const body = answer.body as Answer;
		expect(body).toMatchObject({ ok: true, sent: 1, failed: 1 });
		expect(body.results.find((r) => r.serverId === w.otherServer.id)).toEqual({
			serverId: w.otherServer.id,
			serverName: expect.any(String),
			ok: false,
			message: 'Could not reach the game server (timed out).',
			code: 'unreachable'
		});
		expect(sent.map((s) => s.server)).toEqual([w.server.id]);
		const rows = await rowsFor(MESSAGE);
		expect(rows.map((r) => [r.serverId, r.outcome, r.status, r.message]).sort()).toEqual(
			[
				[w.server.id, 'ok', 200, 'Announcement sent to 13 player(s).'],
				[w.otherServer.id, 'error', 502, 'Could not reach the game server (timed out).']
			].sort()
		);
	});

	test("an unexpected failure is a fixed phrase, never the error's own text", async () => {
		recordingGateway((id) =>
			id === w.otherServer.id ? new Error('connect ECONNREFUSED 203.0.113.9:7779') : null
		);
		const answer = await post('owner', {
			message: MESSAGE,
			serverIds: [w.server.id, w.otherServer.id]
		});
		expect(answer.status).toBe(200);
		const failed = (answer.body as Answer).results.find((r) => !r.ok)!;
		expect(failed).toMatchObject({ message: 'Internal error.', code: 'internal' });
		const rows = await rowsFor(MESSAGE);
		expect(rows.find((r) => r.serverId === w.otherServer.id)).toMatchObject({
			outcome: 'error',
			status: 500,
			message: 'Internal error.'
		});
		for (const text of [JSON.stringify(answer.body), JSON.stringify(rows)])
			expect(text).not.toMatch(/203\.0\.113\.9|ECONNREFUSED/);
	});

	test('when no server takes it the answer is a 502, with how each one did', async () => {
		recordingGateway(() => new GameError(503, 'The worker is not reachable.', 'relay'));
		const answer = await post('owner', {
			message: MESSAGE,
			serverIds: [w.server.id, w.otherServer.id]
		});
		expect(answer.status).toBe(502);
		expect(answer.code).toBe('not_sent');
		const body = answer.body as Answer;
		expect(body).toMatchObject({ ok: false, sent: 0, failed: 2 });
		expect(body.results.every((r) => !r.ok && r.message === 'The worker is not reachable.')).toBe(
			true
		);
	});

	test("the answer and the trail carry nothing of the servers' addresses or password", async () => {
		recordingGateway((id) =>
			id === w.otherServer.id ? new GameError(401, 'Unauthorized.', 'unauthorized') : null
		);
		const answer = await post('keyAll', {
			message: MESSAGE,
			serverIds: [w.server.id, w.otherServer.id]
		});
		const rows = await rowsFor(MESSAGE);
		expect(rows.length).toBe(2);
		// world.ts puts every server at game.test.invalid:7779 with this password
		for (const text of [JSON.stringify(answer.body), JSON.stringify(rows)])
			expect(text).not.toMatch(/game\.test\.invalid|7779|rcon-password|password_enc|passwordEnc/);
		// the game turning the stored password away reads as a single broadcast says it
		expect((answer.body as Answer).results.find((r) => !r.ok)?.message).toBe(
			'The game server rejected the stored RCON password: Unauthorized.'
		);
		expect(rows.find((r) => r.serverId === w.otherServer.id)).toMatchObject({
			outcome: 'error',
			status: 401,
			message: 'Unauthorized.'
		});
		// a key acts as itself in the trail
		expect(rows.every((r) => r.actorId === w.users.keyAll!.id)).toBe(true);
	});

	test("a suspended org's servers are closed to its people and keys, not to the site owner", async () => {
		await suspend(env, w.org.id);
		const sent = recordingGateway();
		for (const who of ['owner', 'operator', 'keyAll'] as PrincipalName[])
			expect({
				who,
				status: (await post(who, { message: MESSAGE, serverIds: null })).status
			}).toEqual({
				who,
				status: 404
			});
		expect(sent).toEqual([]);
		expect((await post('site', { message: MESSAGE, serverIds: [w.server.id] })).status).toBe(200);
		expect(sent.map((s) => s.server)).toEqual([w.server.id]);
	});
});

describe.skipIf(!hasTestDb)("an announcement and the caller's action budget", () => {
	let env: Env;
	let w: World;
	const req = () => new Request('http://localhost:5173/test', { method: 'POST' });

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
	});

	/** The org's servers as the owner sees them, the way the route hands them on. */
	const visible = async (): Promise<ServerSummary[]> => {
		const { accessibleServers } = await import('$lib/server/access');
		return accessibleServers(env, w.users.owner!, w.org.id);
	};
	const org = async () =>
		(await env.db.select().from(organizations).where(eq(organizations.id, w.org.id)))[0];

	test('takes one action of it per server, all of them or none', async () => {
		const sent = recordingGateway();
		const owner = w.users.owner!;
		const body = { message: MESSAGE, serverIds: [w.server.id, w.otherServer.id] };
		resetRates();
		// room for one more action this minute: two servers do not fit, and nothing goes
		expect(
			takeRate(actionBudget(owner.id), ACTIONS_PER_MINUTE - 1, ACTIONS_PER_MINUTE, 60_000)
		).toBe(0);
		const refused = await announce(env, req(), owner, await org(), await visible(), body).catch(
			(err) => err
		);
		expect(refused).toBeInstanceOf(ApiError);
		expect((refused as ApiError).status).toBe(429);
		expect(sent).toEqual([]);
		// room for exactly two
		resetRates();
		takeRate(actionBudget(owner.id), ACTIONS_PER_MINUTE - 2, ACTIONS_PER_MINUTE, 60_000);
		const answer = await announce(env, req(), owner, await org(), await visible(), body);
		expect(answer.sent).toBe(2);
		// and a single broadcast after it finds the minute spent
		expect(takeRate(actionBudget(owner.id), 1, ACTIONS_PER_MINUTE, 60_000)).toBeGreaterThan(0);
		resetRates();
	});

	test('a refusal takes from the budget too, so its trail rows are bounded like the sends', async () => {
		const sent = recordingGateway();
		const operator = w.users.operator!;
		// the operator also sees the other server, as a viewer
		await env.db.insert(serverGrants).values({
			serverId: w.otherServer.id,
			userId: operator.id,
			roleId: w.roles.viewer
		});
		const { accessibleServers } = await import('$lib/server/access');
		const seen = await accessibleServers(env, operator, w.org.id);
		const message = `${MESSAGE} (refused)`;
		const body = { message, serverIds: [w.server.id, w.otherServer.id] };
		const denied = async () =>
			(
				await env.db
					.select()
					.from(auditLog)
					.where(and(eq(auditLog.target, message), eq(auditLog.outcome, 'denied')))
			).length;
		resetRates();
		// one action left this minute: the two servers named do not fit, and nothing is written
		takeRate(actionBudget(operator.id), ACTIONS_PER_MINUTE - 1, ACTIONS_PER_MINUTE, 60_000);
		const late = await announce(env, req(), operator, await org(), seen, body).catch((e) => e);
		expect((late as ApiError).status).toBe(429);
		expect(await denied()).toBe(0);
		// with room for them: refused, one denied row, and both servers spent
		resetRates();
		const refused = await announce(env, req(), operator, await org(), seen, body).catch((e) => e);
		expect((refused as ApiError).status).toBe(403);
		expect(await denied()).toBe(1);
		expect(
			takeRate(actionBudget(operator.id), ACTIONS_PER_MINUTE - 1, ACTIONS_PER_MINUTE, 60_000)
		).toBeGreaterThan(0);
		expect(sent).toEqual([]);
		resetRates();
	});

	test('naming more servers than one announcement reaches is refused before any is looked at', async () => {
		const sent = recordingGateway();
		resetRates();
		const ids = Array.from({ length: ANNOUNCE_MAX + 1 }, (_, i) => `s_nowhere_${i}`);
		const refused = await announce(env, req(), w.users.owner!, await org(), await visible(), {
			message: MESSAGE,
			serverIds: ids
		}).catch((e) => e);
		// a 400, not the 404 an unknown server would be: the list is not read at all
		expect((refused as ApiError).status).toBe(400);
		expect((refused as ApiError).code).toBe('too_many');
		expect(sent).toEqual([]);
		resetRates();
	});

	test(`reaches at most ${ANNOUNCE_MAX} servers`, async () => {
		const sent = recordingGateway();
		const one = (await visible())[0];
		const many = Array.from({ length: ANNOUNCE_MAX + 1 }, (_, i) => ({
			...one,
			id: `s_many_${i}`
		}));
		resetRates();
		const refused = await announce(env, req(), w.users.owner!, await org(), many, {
			message: MESSAGE,
			serverIds: null
		}).catch((err) => err);
		expect((refused as ApiError).status).toBe(400);
		expect((refused as ApiError).code).toBe('too_many');
		expect(sent).toEqual([]);
		// a server that is no longer the org's (deleted, say) is answered for, not sent to
		const answer = await announce(
			env,
			req(),
			w.users.owner!,
			await org(),
			[one, { ...one, id: 's_gone' }],
			{
				message: MESSAGE,
				serverIds: [one.id, 's_gone']
			}
		);
		expect(answer.results.find((r) => r.serverId === 's_gone')).toMatchObject({
			ok: false,
			code: 'not_found'
		});
		expect(sent.map((s) => s.server)).toEqual([one.id]);
		resetRates();
	});
});
