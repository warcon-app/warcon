// Text Postgres will not store: NUL anywhere, and half a UTF-16 surrogate pair in jsonb. Either
// failed the whole statement, so a game action whose text held one reached the game and then lost
// its audit row (and its Discord card) to a 500, a list save answered 500, and a match's player
// rows were not written. They are stored with U+FFFD in their place.
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import {
	auditLog,
	matches,
	matchPlayers,
	orgBanReasons,
	playerSessions,
	serverBans
} from '$lib/server/db/schema';
import { stringify, uneval } from 'devalue';
import { writeAudit } from '$lib/server/audit';
import { noteLocalEdit, writeSnapshot } from '$lib/server/lists-sync';
import { writeMatchPlayers } from '$lib/server/match-players';
import { newPresence, persistPresence, type PresenceDiff } from '$lib/server/sessions';
import { storable, storableText } from '$lib/server/db/storable';
import type { Player } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, stubGateway } from './call';
import { seedWorld, type World } from './world';

const NUL = '\u0000';
const HIGH = '\uD800';
const LOW = '\uDC00';
const R = '\uFFFD';
const PLAYER = '76561198000000431';
const ROUTES = join(import.meta.dir, '..', 'routes', 'api');

describe('text made storable', () => {
	test('NUL and half a surrogate pair become U+FFFD; anything else stays as it is', () => {
		expect(storableText(`a${NUL}b${HIGH}c${LOW}d`)).toBe(`a${R}b${R}c${R}d`);
		expect(storableText(`ends ${HIGH}`)).toBe(`ends ${R}`);
		const fine = 'Team killing 🎯 \u0001 tab\there';
		expect(storableText(fine)).toBe(fine);
	});

	test('every string in a jsonb value, keys too; a clean value comes back as it is', () => {
		const when = new Date(0);
		const clean = { a: ['x', 1, null, { b: 'y 🎯' }], when };
		expect(storable(clean)).toBe(clean);
		// rebuilt as JSON.stringify sees it: the Date as the ISO string Postgres would get anyway
		expect(storable({ [`k${NUL}`]: [`v${HIGH}`, { deep: LOW }], when, n: 3 })).toEqual({
			[`k${R}`]: [`v${R}`, { deep: R }],
			when: when.toJSON(),
			n: 3
		});
		expect(storable(`x${NUL}`)).toBe(`x${R}`);
		expect(storable(7)).toBe(7);
		expect(storable(null)).toBe(null);
	});
});

describe.skipIf(!hasTestDb)('text Postgres refuses, from a caller or the game', () => {
	let env: Env;
	let w: World;
	let game: ReturnType<typeof stubGateway>;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		game = stubGateway({ message: 'Done.' });
	});

	/** A game action as the operator; a failed insert's log line is kept out of the output. */
	const act = async (action: string, body: object | string) => {
		const { POST } = await import('../routes/api/servers/[id]/rcon/[action]/+server');
		const quiet = console.error;
		console.error = () => {};
		try {
			return await callApi(POST, w.users.operator, {
				method: 'POST',
				params: { id: w.server.id, action },
				...(typeof body === 'string' ? { raw: body } : { body })
			});
		} finally {
			console.error = quiet;
		}
	};
	const lastRow = async (action: string) =>
		(
			await env.db
				.select()
				.from(auditLog)
				.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.action, action)))
				.orderBy(desc(auditLog.id))
				.limit(1)
		)[0];

	test('a broadcast that reached the game is in the audit trail, whatever its text held', async () => {
		for (const bad of [NUL, HIGH, LOW]) {
			const before = game.runs.length;
			const answer = await act('broadcast', { message: `hidden ${bad} broadcast` });
			expect(game.runs.length).toBe(before + 1);
			expect({ bad, status: answer.status }).toEqual({ bad, status: 200 });
			const row = await lastRow('rcon.broadcast');
			expect(row).toMatchObject({ outcome: 'ok', target: `hidden ${R} broadcast` });
			expect((row.detail as { message: string }).message).toBe(`hidden ${R} broadcast`);
		}
	});

	test("so is a kick, with its reason's text", async () => {
		const answer = await act('kick', { steamId: PLAYER, reason: `rule ${NUL}${HIGH} broken` });
		expect(answer.status).toBe(200);
		const row = await lastRow('rcon.kick');
		expect(row).toMatchObject({ outcome: 'ok', target: PLAYER });
		expect((row.detail as { reason: string }).reason).toBe(`rule ${R}${R} broken`);
	});

	test('an audit row takes them in every text it carries', async () => {
		await writeAudit(env, null, {
			actorName: `bot${NUL}`,
			server: { id: w.server.id, name: 'server' },
			category: 'system',
			action: 'probe.unstorable',
			outcome: 'ok',
			target: `t${HIGH}`,
			message: `m${NUL}`,
			detail: { [`k${LOW}`]: [`v${NUL}`] }
		});
		const row = await lastRow('probe.unstorable');
		expect(row).toMatchObject({ actorName: `bot${R}`, target: `t${R}`, message: `m${R}` });
		expect(row.detail).toEqual({ [`k${R}`]: [`v${R}`] });
	});

	test('a jsonb column takes them: quick reasons save instead of a 500', async () => {
		const { PATCH } = await import(join(ROUTES, 'orgs/[id]', '+server.ts'));
		const quiet = console.error;
		console.error = () => {};
		let answer;
		try {
			answer = await callApi(PATCH, w.users.owner, {
				method: 'PATCH',
				params: { id: w.org.id },
				body: { banReasons: [{ label: `Odd${HIGH}`, reason: `a${NUL}b`, days: null }] }
			});
		} finally {
			console.error = quiet;
		}
		expect(answer.status).toBe(200);
		const [row] = await env.db
			.select({ reasons: orgBanReasons.reasons })
			.from(orgBanReasons)
			.where(eq(orgBanReasons.orgId, w.org.id));
		expect(row.reasons).toEqual([{ label: `Odd${R}`, reason: `a${R}b`, days: null }]);
	});

	test('a session closes when the name the game sent last holds half an emoji', async () => {
		const presence = newPresence();
		presence.loaded = true;
		const player: Player = {
			steamId: '76561198000000433',
			name: 'Half',
			faction: 'Valkyra',
			kills: 0,
			deaths: 0,
			cash: 0,
			ping: 20
		};
		const none: PresenceDiff = {
			joined: [],
			left: [],
			stayed: [],
			factioned: [],
			renamed: [],
			returned: []
		};
		const at = new Date(Date.now() - 60_000);
		await persistPresence(env.db, w.server.id, presence, { ...none, joined: [player] }, at, false);
		const session = presence.open.get(player.steamId)!;
		session.name = `Half${HIGH}`;
		await persistPresence(
			env.db,
			w.server.id,
			presence,
			{ ...none, left: [session] },
			new Date(),
			false
		);
		const [row] = await env.db
			.select({ name: playerSessions.name, leftAt: playerSessions.leftAt })
			.from(playerSessions)
			.where(eq(playerSessions.steamId, player.steamId));
		expect(row.name).toBe(`Half${R}`);
		expect(row.leftAt).not.toBeNull();
	});

	test("a match's player rows are written when a name the game sent holds them", async () => {
		const [match] = await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: new Date(), map: 'Zestafona', peakPlayers: 2 })
			.returning({ id: matches.id });
		await writeMatchPlayers(env.db, w.server.id, match.id, [
			{
				steamId: PLAYER,
				name: `Half${HIGH}`,
				faction: 'Red',
				seconds: 60,
				idleSeconds: 0,
				kills: 1,
				deaths: 0,
				cashDelta: 0
			},
			{
				steamId: `${PLAYER.slice(0, -1)}2`,
				name: `N${NUL}l`,
				faction: 'Blue',
				seconds: 30,
				idleSeconds: 0,
				kills: 0,
				deaths: 1,
				cashDelta: 0
			}
		]);
		const rows = await env.db
			.select({ name: matchPlayers.name })
			.from(matchPlayers)
			.where(eq(matchPlayers.matchId, match.id));
		expect(rows.map((r) => r.name).sort()).toEqual([`Half${R}`, `N${R}l`]);
	});

	// What the walk must not open: a key named __proto__, text shaped like SQL or JSON, depth.

	test('a key named __proto__ cannot slip an action past its audit row, nor pollute', async () => {
		const sent = JSON.parse(`{"message":"a\\u0000b","__proto__":{"note":"x\\u0000"}}`);
		const answer = await act('broadcast', sent);
		expect(answer.status).toBe(200);
		const row = await lastRow('rcon.broadcast');
		expect(row).toMatchObject({ outcome: 'ok', target: `a${R}b` });
		// the trail keeps what was sent, under a key that is plain data wherever the row goes
		expect(row.detail).toEqual({ message: `a${R}b`, '__proto__ (key)': { note: `x${R}` } });
		expect(Object.hasOwn(row.detail as object, '__proto__')).toBe(false);
		expect(({} as Record<string, unknown>).note).toBeUndefined();
		const walked = storable(sent) as Record<string, unknown>;
		expect(Object.getPrototypeOf(walked)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).note).toBeUndefined();
	});

	test("a viewer's refused action with a __proto__ key leaves the Audit page renderable", async () => {
		const { POST } = await import('../routes/api/servers/[id]/rcon/[action]/+server');
		const refused = await callApi(POST, w.users.viewer, {
			method: 'POST',
			params: { id: w.server.id, action: 'broadcast' },
			raw: '{"message":"hi","__proto__":{"note":"x"}}'
		});
		expect(refused.status).toBe(403);
		const row = await lastRow('rcon.broadcast');
		expect(row).toMatchObject({ outcome: 'denied' });
		expect(row.detail).toEqual({ message: 'hi', '__proto__ (key)': { note: 'x' } });
		// the page's data reaches the browser through devalue, which refuses a __proto__ key
		const { load } = await import('../routes/(app)/audit/+page.server');
		for (const who of [w.users.site, w.users.owner, w.users.viewer]) {
			const page = await callLoad(load, who, { query: `server=${w.server.id}` });
			expect(page.status).toBe(200);
			expect((page.body as { entries: unknown[] }).entries.length).toBeGreaterThan(0);
			expect(() => uneval(page.body)).not.toThrow();
			expect(() => stringify(page.body)).not.toThrow();
		}
	});

	test('a ban reason holding NUL, as the game hands it back, still syncs', async () => {
		const ban = (steamId: string) => ({
			steamId,
			reason: `rule ${NUL} broken`,
			bannedBy: `adm${NUL}`,
			bannedAtUtc: `2026-10-16${NUL}`
		});
		await writeSnapshot(env, w.server.id, {
			bans: [ban('76561198000000611'), ban('76561198000000612')],
			reserved: [],
			configured: []
		});
		await noteLocalEdit(env, w.server.id, 'ban', 'add', '76561198000000613', {
			reason: `mirror ${NUL}`
		});
		const rows = await env.db
			.select({
				steamId: serverBans.steamId,
				reason: serverBans.reason,
				bannedBy: serverBans.bannedBy,
				bannedAtUtc: serverBans.bannedAtUtc
			})
			.from(serverBans)
			.where(eq(serverBans.serverId, w.server.id));
		expect(rows.sort((a, b) => a.steamId.localeCompare(b.steamId))).toEqual([
			{
				steamId: '76561198000000611',
				reason: `rule ${R} broken`,
				bannedBy: `adm${R}`,
				bannedAtUtc: `2026-10-16${R}`
			},
			{
				steamId: '76561198000000612',
				reason: `rule ${R} broken`,
				bannedBy: `adm${R}`,
				bannedAtUtc: `2026-10-16${R}`
			},
			{ steamId: '76561198000000613', reason: `mirror ${R}`, bannedBy: '', bannedAtUtc: '' }
		]);
	});

	test('an object with an odd prototype is walked as JSON would serialise it', () => {
		const odd = Object.create({ inherited: `i${NUL}` }) as Record<string, unknown>;
		odd.own = `o${NUL}`;
		expect(storable(odd)).toEqual({ own: `o${R}` });
		expect(storable({ when: new Date(0), at: { toJSON: () => `t${NUL}` } })).toEqual({
			when: new Date(0).toJSON(),
			at: `t${R}`
		});
	});

	test('text shaped like SQL or JSON is stored as the text it is', async () => {
		const sqlish = `x'); DROP TABLE match_players; --${NUL}`;
		const jsonish = `"},{"steam_id":"76561198000000999","name":"injected`;
		const [match] = await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: new Date(), map: 'Zestafona', peakPlayers: 2 })
			.returning({ id: matches.id });
		const line = { faction: 'Red', seconds: 1, idleSeconds: 0, kills: 0, deaths: 0, cashDelta: 0 };
		await writeMatchPlayers(env.db, w.server.id, match.id, [
			{ ...line, steamId: '76561198000000501', name: sqlish },
			{ ...line, steamId: '76561198000000502', name: jsonish }
		]);
		const rows = await env.db
			.select({ steamId: matchPlayers.steamId, name: matchPlayers.name })
			.from(matchPlayers)
			.where(eq(matchPlayers.matchId, match.id));
		expect(rows.sort((a, b) => a.steamId.localeCompare(b.steamId))).toEqual([
			{ steamId: '76561198000000501', name: sqlish.replace(NUL, R) },
			{ steamId: '76561198000000502', name: jsonish }
		]);
		await writeAudit(env, null, {
			server: { id: w.server.id, name: 'server' },
			category: 'system',
			action: 'probe.shaped',
			outcome: 'ok',
			target: sqlish,
			detail: { [jsonish]: sqlish, nested: [jsonish] }
		});
		const audit = await lastRow('probe.shaped');
		expect(audit.target).toBe(sqlish.replace(NUL, R));
		expect(audit.detail).toEqual({
			[jsonish]: sqlish.replace(NUL, R),
			nested: [jsonish]
		});
	});

	test('params nested far deeper than the trail keeps are still audited', async () => {
		// 200,000 levels, past what JSON.stringify or any recursive walk survives: the body arrives as
		// text, which JSON.parse reads, and the trail cuts detail at seven levels before anything walks it
		const depth = 200_000;
		const raw = `{"message":"deep \\u0000","extra":${'['.repeat(depth)}"bottom"${']'.repeat(depth)}}`;
		const answer = await act('broadcast', raw);
		expect(answer.status).toBe(200);
		const row = await lastRow('rcon.broadcast');
		expect(row).toMatchObject({ outcome: 'ok', target: `deep ${R}` });
		expect(JSON.stringify(row.detail)).toContain('[deep]');
	});
});
