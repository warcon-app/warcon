// Every rule's messages fill the same placeholders from one place: the server's in every message,
// the player's (and their stats) in every message to or about one, the rule's own on top. Kick
// reasons are filled like whispers. Stats that cannot be read show as … and the rule acts anyway.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { evaluateTriggers, validateConfig, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';
import type { Env } from './env';
import type { Player, TriggerKind } from '$lib/types';

const OWL: Player = {
	name: '[ABC] Night Owl',
	steamId: '76561198000000701',
	faction: 'Valkyra',
	kills: 3,
	deaths: 1,
	cash: 0,
	ping: 48.6
};
const NOW = Date.parse('2026-10-02T05:30:00Z');

const rule = (kind: TriggerKind, config: Record<string, unknown>, state: unknown = null) =>
	({
		id: `rule-${kind}-${Math.random()}`,
		name: kind,
		kind,
		config: validateConfig(kind, config),
		state,
		lastFiredAt: null
	}) as unknown as TriggerRow;

const tick = (over: Partial<TickContext> = {}) =>
	({
		server: { id: 'srv', name: 'Panel name' },
		status: {
			serverName: 'Example Clan #1',
			map: 'NorthAmerica',
			playerCount: 41,
			maxPlayers: 100,
			scores: [
				{ name: 'Valkyra', score: 45 },
				{ name: 'Lonestar', score: 30 }
			],
			scoreCap: null
		},
		players: [OWL],
		playersObserved: true,
		playersIntervalMs: 2000,
		joined: [],
		renamed: [],
		returned: [],
		riskCheck: [],
		factioned: [],
		firstVisit: new Set(),
		reserved: new Set(),
		reservedLoaded: true,
		seedMs: new Map(),
		signals: new Map(),
		profiles: new Map(),
		performance: new Map(),
		startedAt: Date.parse('2026-10-02T00:00:00Z'),
		matchEnd: null,
		matchLines: [],
		ts: new Date(NOW),
		...over
	}) as unknown as TickContext;

/** What one rule queued at one look: each intent's text, whisper or kick reason. */
const texts = async (row: TriggerRow, ctx: TickContext) =>
	(await evaluateTriggers({} as Env, ctx, [row])).intents.map(
		(i) => (i.params.message ?? i.params.reason) as string
	);

const EVERYTHING =
	'{player} {faction} {steamid} {ping} · {map} {players}/{max} · {scores} · cap {cap} · up {uptime}';
const FILLED = `[ABC] Night Owl Valkyra ${OWL.steamId} 49 · Zestafona 41/100 · Valkyra 45 · Lonestar 30 · cap 100 · up 5h 30m`;

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
	warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('placeholders every rule fills', () => {
	test('a welcome whisper', async () => {
		expect(await texts(rule('welcome', { message: EVERYTHING }), tick({ joined: [OWL] }))).toEqual([
			FILLED
		]);
	});
	test('a faction change whisper, with the side they left', async () => {
		const ctx = tick({ factioned: [{ player: OWL, from: 'Lonestar' }] });
		expect(
			await texts(rule('faction_change', { message: `${EVERYTHING} · was {previous}` }), ctx)
		).toEqual([`${FILLED} · was Lonestar`]);
	});
	test('a kick on connect risk: the reason is filled, and never says why the panel kicked', async () => {
		const ctx = tick({
			riskCheck: [OWL],
			signals: new Map([
				[OWL.steamId, { watched: { reason: 'staff note' }, bannedOn: [], resembles: [] }]
			])
		} as Partial<TickContext>);
		const reason = await texts(
			rule('risk_kick', { watchlist: true, reason: `${EVERYTHING} {why}` }),
			ctx
		);
		expect(reason).toEqual([`${FILLED} {why}`]);
	});
	test('a high ping kick says the ping that decided it', async () => {
		const since = NOW - 120_000;
		const row = rule(
			'ping_kick',
			{ maxPingMs: 40, durationSeconds: 60, reason: `${EVERYTHING} over 40 ms` },
			{ lastAt: NOW - 2000, players: { [OWL.steamId]: { since, fired: false } } }
		);
		expect(await texts(row, tick())).toEqual([`${FILLED} over 40 ms`]);
	});
	test('a name filter kick, with the kind of fault', async () => {
		const row = rule('name_filter', {
			characters: 'ascii',
			builtinWords: false,
			action: 'kick',
			reason: `${EVERYTHING}: {why}`
		});
		const accented = { ...OWL, name: 'Nüght Owl' };
		const [reason] = await texts(row, tick({ joined: [accented], players: [accented] }));
		expect(reason).toStartWith(FILLED.replace('[ABC] Night Owl', 'Nüght Owl'));
		expect(reason).toContain(': it uses');
	});
	test('messages to everyone fill the server and leave a player’s placeholders blank', async () => {
		const row = rule('broadcast', { messages: [`${EVERYTHING} {kills}`], everyMinutes: 5 });
		expect(await texts(row, tick())).toEqual([
			'    · Zestafona 41/100 · Valkyra 45 · Lonestar 30 · cap 100 · up 5h 30m '
		]);
	});
	test('an AFK protection round, with its goal', async () => {
		// four minutes into a seeding stretch: a round is due
		const row = rule(
			'afk_protection',
			{ message: '{players} of {goal} on {map}' },
			{
				on: true,
				since: NOW - 600_000,
				startedAt: Date.parse('2026-10-02T00:00:00Z'),
				seedingSince: NOW - 240_000,
				roundAt: 0,
				why: ''
			}
		);
		const quiet = tick({
			status: { ...tick().status, playerCount: 1, scores: [] },
			players: [OWL]
		});
		expect(await texts(row, quiet)).toEqual(['1 of 20 on Zestafona']);
	});
	test('an AFK watch warning and kick, with how long the player has been idle and when it acts', async () => {
		const row = rule('afk_watch', {
			minutes: 15,
			warnMinutes: 10,
			warnMessage: '{player} ({steamid}) on {map}: idle {idle} min, kicked at {limit}',
			minPlayers: 1,
			reason: '{player} on {map}: idle {idle} of {limit} min'
		});
		// a slow cadence, so looks minutes apart are no gap in the rule's watch; someone else on,
		// earning, so the rule sees the server's cash move
		const at = async (minute: number) => {
			const earner = { ...OWL, name: 'Earner', steamId: '76561198000000702', cash: minute * 100 };
			const ctx = tick({
				ts: new Date(NOW + minute * 60_000),
				playersIntervalMs: 600_000,
				players: [OWL, earner]
			});
			const ev = await evaluateTriggers({} as Env, ctx, [row]);
			for (const f of ev.afterCommit ?? []) f();
			return ev.intents.map((i) => (i.params.message ?? i.params.reason) as string);
		};
		expect(await at(0)).toEqual([]);
		expect(await at(11)).toEqual([
			`[ABC] Night Owl (${OWL.steamId}) on Zestafona: idle 11 min, kicked at 15`
		]);
		expect(await at(16)).toEqual(['[ABC] Night Owl on Zestafona: idle 16 of 15 min']);
	});
	test('a match broadcast names the map that ended as players know it', async () => {
		const row = rule('match_broadcast', {
			endMessage: '{faction} won {previous} {score}-{scores}',
			startMessage: 'Now {map}'
		});
		const end = {
			map: 'Kavkazi',
			scores: [
				{ name: 'Valkyra', score: 100 },
				{ name: 'Lonestar', score: 81 }
			],
			winner: 'Valkyra',
			leaders: ['Valkyra']
		};
		expect(await texts(row, tick({ matchEnd: end }))).toEqual([
			'Valkyra won Bakurani 100-Valkyra 100 · Lonestar 81',
			'Now Zestafona'
		]);
	});
});

describe('stats in a message', () => {
	test('stats that cannot be read show as …, the whisper goes all the same, and the log names no player', async () => {
		const row = rule('welcome', { message: 'Welcome {player}: {kills} kills, K/D {KDR}' });
		expect(await texts(row, tick({ joined: [OWL] }))).toEqual([
			'Welcome [ABC] Night Owl: … kills, K/D …'
		]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toBe('[warcon] player stats on srv:');
	});
	test('a message without them reads nothing', async () => {
		const row = rule('welcome', { message: 'Welcome {player}' });
		expect(await texts(row, tick({ joined: [OWL] }))).toEqual(['Welcome [ABC] Night Owl']);
		expect(warn).not.toHaveBeenCalled();
	});
});
