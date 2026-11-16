// The Map vote rule: its settings, the maps a vote offers, the vote as it moves at each look, the
// votes it takes, and its opening and winner against the mock game.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Env } from './env';
import { WardogsClient } from './rcon';
import { ApiError } from './http';
import { readConfig } from './actions';
import {
	applyVoteOnServer,
	castBallot,
	chatReadRecently,
	countVotes,
	fillOptions,
	forgetVotes,
	noteChatRead,
	openVoteOnServer,
	OPENING_MS,
	optionsLine,
	READING_MS,
	tallyLine,
	validateMapVote,
	voteOf,
	voteOptions,
	voteReplay,
	voteStep,
	voteWantsChat,
	voteWords,
	winnerOf,
	type MapVoteConfig,
	type VoteLook
} from './map-vote';
import { MAP_VOTE_DEFAULTS } from '../map-vote';
import { MAX_CHAT } from '../chat';
import { rotationFromText, rotationIntoText } from '../rotation-doc';
import type { MapSelection } from '../types';

const entry = (map: string, experiences: string[] = [], zone = '', lighting = 'DayClear') => ({
	map,
	experiences,
	lighting,
	zoneAlternator: zone
});

describe('validateMapVote', () => {
	test('a rule saved with nothing starts from the usual settings and texts', () => {
		expect(validateMapVote({})).toEqual({ ...MAP_VOTE_DEFAULTS });
	});
	test('numbers are held to their bounds, texts to one line the game takes', () => {
		const c = validateMapVote({
			startAt: 150,
			seconds: 5,
			options: 9,
			minPlayers: 0,
			minVotes: '7',
			openMessage: `Vote!\n{OPTIONS} ${'x'.repeat(400)}`,
			tallyMessage: '',
			noneMessage: ''
		});
		expect([c.startAt, c.seconds, c.options, c.minPlayers, c.minVotes]).toEqual([99, 30, 5, 1, 7]);
		expect(c.openMessage.startsWith('Vote! {OPTIONS} x')).toBe(true);
		expect(c.openMessage.length).toBe(MAX_CHAT);
		// blank: said not at all
		expect([c.tallyMessage, c.noneMessage]).toEqual(['', '']);
	});
	test('the opening must list the options, and the result must be said', () => {
		expect(() => validateMapVote({ openMessage: 'Vote now!' })).toThrow(ApiError);
		expect(() => validateMapVote({ openMessage: 'Vote now!' })).toThrow('{options}');
		expect(() => validateMapVote({ resultMessage: '  ' })).toThrow('which map won');
	});
	test('its words in chat are its options’ numbers', () => {
		expect(voteWords(validateMapVote({}))).toEqual(['1', '2', '3']);
		expect(voteWords(validateMapVote({ options: 5 }))).toEqual(['1', '2', '3', '4', '5']);
		expect(voteWords(null)).toEqual(['1', '2', '3']);
	});
});

describe('voteOptions', () => {
	test('from the entry next: the first of each other map, never the map being played', () => {
		const entries = [
			entry('Kavkazi', [], 'A'), // on
			entry('Europe', [], 'A'), // next
			entry('Russia', [], 'A'),
			entry('Kavkazi', [], 'B'),
			entry('Europe', [], 'B'),
			entry('NorthAmerica', [], 'A')
		];
		const options = voteOptions(entries, 0, 1, 'Kavkazi', 5);
		expect(options.map((o) => [o.index, o.entry.map])).toEqual([
			[1, 'Europe'],
			[2, 'Russia'],
			[5, 'NorthAmerica']
		]);
		expect(optionsLine(options)).toBe('!1 Ozeti · !2 Sabatulo · !3 Zestafona');
		// at most as many as asked
		expect(voteOptions(entries, 0, 1, 'Kavkazi', 2).map((o) => o.entry.map)).toEqual([
			'Europe',
			'Russia'
		]);
	});
	test('round the list from the entry next, wrapping', () => {
		const entries = [entry('Europe'), entry('NorthAmerica'), entry('Kavkazi'), entry('Russia')];
		// on Kavkazi (2), Russia next (3): then round to Europe and NorthAmerica
		expect(voteOptions(entries, 2, 3, 'Kavkazi', 3).map((o) => o.index)).toEqual([3, 0, 1]);
		// a server that names no next entry: from the one after the entry on
		expect(voteOptions(entries, 2, -1, 'Kavkazi', 3).map((o) => o.index)).toEqual([3, 0, 1]);
		// nor the entry on: from the top
		expect(voteOptions(entries, -1, -1, 'Kavkazi', 3).map((o) => o.index)).toEqual([0, 1, 3]);
	});
	test('the map being played is left out however the status names it', () => {
		const entries = [entry('Europe'), entry('Kavkazi'), entry('Russia')];
		// a live status names the map as players know it
		expect(voteOptions(entries, -1, 0, 'Bakurani', 3).map((o) => o.entry.map)).toEqual([
			'Europe',
			'Russia'
		]);
		// the entry on is left out by its own map, whatever the status says
		expect(voteOptions(entries, 2, 0, '', 3).map((o) => o.entry.map)).toEqual([
			'Europe',
			'Kavkazi'
		]);
	});
	test('each as the rotation has it; played differently, each option says how', () => {
		// an Infantry Only rotation offers Infantry Only maps, and says nothing of it
		const infantry = [
			entry('Kavkazi', ['Bakurani_KOTH_01', 'KOTH_InfantryOnly']), // on
			entry('Europe', ['Madrid_KOTH_01', 'KOTH_InfantryOnly']), // next
			entry('Russia', ['Moscow_KOTH_01', 'KOTH_InfantryOnly'])
		];
		const alike = voteOptions(infantry, 0, 1, 'Kavkazi', 5);
		expect(alike.map((o) => o.entry.experiences)).toEqual([
			['Madrid_KOTH_01', 'KOTH_InfantryOnly'],
			['Moscow_KOTH_01', 'KOTH_InfantryOnly']
		]);
		expect(optionsLine(alike)).toBe('!1 Ozeti · !2 Sabatulo');
		// a rotation that mixes them: the first entry of each map, said with how it is played
		const mixed = [
			entry('Kavkazi', ['Bakurani_KOTH_01']), // on
			entry('Europe', ['Madrid_KOTH_01', 'KOTH_InfantryOnly']), // next
			entry('Russia', ['Moscow_KOTH_01']),
			entry('Russia', ['Moscow_KOTH_01', 'KOTH_InfantryOnly']),
			entry('NorthAmerica', ['Detroit_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore'])
		];
		const options = voteOptions(mixed, 0, 1, 'Kavkazi', 5);
		expect(options.map((o) => o.index)).toEqual([1, 2, 4]);
		expect(optionsLine(options)).toBe(
			'!1 Ozeti (Infantry Only) · !2 Sabatulo · !3 Zestafona (Infantry Only, Hardcore)'
		);
		expect(tallyLine(options, [2, 0, 1])).toBe(
			'!1 Ozeti (Infantry Only) 2 · !2 Sabatulo 0 · !3 Zestafona (Infantry Only, Hardcore) 1'
		);
		// Limited Gear under either of its ids is one modifier
		const gear = [
			entry('Kavkazi'),
			entry('Europe', ['KOTH_LimitedGear']),
			entry('Russia', ['LimitedGear', 'KOTH_LimitedGear'])
		];
		expect(optionsLine(voteOptions(gear, 0, 1, 'Kavkazi', 5))).toBe('!1 Ozeti · !2 Sabatulo');
	});
	test('an entry the server refuses is no option', () => {
		const entries = [
			{ ...entry('Kavkazi'), denied: false },
			{ ...entry('Europe'), denied: true },
			{ ...entry('Russia'), denied: false }
		];
		expect(voteOptions(entries, 0, 1, 'Kavkazi', 3).map((o) => o.entry.map)).toEqual(['Russia']);
		expect(voteOptions([], 0, 1, 'Kavkazi', 3)).toEqual([]);
	});
});

describe('the texts', () => {
	test('the options go in where the opening says, in any case, as written', () => {
		expect(fillOptions('Vote: {Options} ({options})', '!1 A · !2 B')).toBe(
			'Vote: !1 A · !2 B (!1 A · !2 B)'
		);
		// a map name is text, never a pattern
		expect(fillOptions('{options}', "$& $' $1")).toBe("$& $' $1");
		// a text too long for the list: the list stays whole, the words round it give way
		const line = '!1 Ozeti · !2 Zestafona (Infantry Only) · !3 Sabatulo';
		const long = fillOptions(`${'a'.repeat(240)} {options} ${'z'.repeat(40)}`, line);
		expect(long.length).toBeLessThanOrEqual(MAX_CHAT);
		expect(long.endsWith(line)).toBe(true);
		expect(fillOptions(`Vote: {options} ${'z'.repeat(250)}`, line)).toStartWith(`Vote: ${line} zz`);
		// never half a character
		expect(fillOptions(`${'😀'.repeat(120)}{options}`, line)).toEndWith(line);
	});
	test('the votes so far, counted once a player', () => {
		const options = voteOptions(
			[entry('Kavkazi'), entry('Europe'), entry('Russia')],
			0,
			1,
			'Kavkazi',
			3
		);
		const ballots = new Map([
			['a', 1],
			['b', 2],
			['c', 2],
			['d', 7]
		]);
		const counts = countVotes(options, ballots);
		expect(counts).toEqual([1, 2]);
		expect(tallyLine(options, counts)).toBe('!1 Ozeti 1 · !2 Sabatulo 2');
	});
	test('the winner has the most votes; a tie is drawn among the tied; no votes, none', () => {
		expect(winnerOf([1, 4, 2])).toEqual({ index: 1, tied: false });
		expect(winnerOf([3, 1, 3], () => 0)).toEqual({ index: 0, tied: true });
		expect(winnerOf([3, 1, 3], () => 0.99)).toEqual({ index: 2, tied: true });
		expect(winnerOf([0, 0])).toBeNull();
		expect(winnerOf([])).toBeNull();
	});
});

describe('the vote at each look', () => {
	const cfg: MapVoteConfig = validateMapVote({ minPlayers: 10, startAt: 90, seconds: 60 });
	let n = 0;
	let server = '';
	const T0 = 1_800_000_000_000;
	const look = (over: Partial<VoteLook> = {}): VoteLook => ({
		now: T0,
		map: 'Kavkazi',
		leading: 91,
		cap: 100,
		players: 40,
		boundary: false,
		reading: true,
		...over
	});
	/** One look, decided and written as a look whose write goes through. */
	const step = (over: Partial<VoteLook> = {}, under = 'u1', c = cfg) => {
		const d = voteStep(server, 'rule', under, c, look(over), () => 0);
		d.commit();
		return d.step;
	};
	/** One look whose write fails: decided, never written. */
	const unwritten = (over: Partial<VoteLook> = {}) =>
		voteStep(server, 'rule', 'u1', cfg, look(over), () => 0).step;
	/** The leader at 89, then past the score: the vote decided at `at`. */
	const decide = (at = T0) => {
		step({ now: at - 2_000, leading: 89 });
		return step({ now: at });
	};
	/** the opening as delivery leaves it: options said, open for the rule's seconds from `at` */
	const opened = (at = T0 + 1_000) => {
		const v = voteOf(server)!;
		v.options = voteOptions(
			[entry('Kavkazi'), entry('Europe'), entry('Russia'), entry('NorthAmerica')],
			0,
			1,
			'Kavkazi',
			3
		);
		v.openedAt = at;
		v.closesAt = at + cfg.seconds * 1000;
		v.phase = 'open';
		return v;
	};
	afterEach(() => forgetVotes());
	const fresh = () => (server = `vote-${++n}`);

	test('opens as the leader passes the score, with the chat read and enough on', () => {
		fresh();
		// the first look this worker has is past the score already: it waits for the next match
		expect(step({ leading: 92 })).toBeNull();
		expect(step({ now: T0 + 2_000, leading: 93 })).toBeNull();
		expect(voteOf(server)).toBeUndefined();
		fresh();
		expect(step({ now: T0 - 2_000, leading: 89 })).toBeNull();
		expect(unwritten({ reading: false })).toBeNull();
		expect(unwritten({ players: 9 })).toBeNull();
		// won already: the end-of-match screen still shows the winner's score
		expect(unwritten({ leading: 100 })).toBeNull();
		// a new map, or the scores falling back, is a new match, not a pass
		expect(unwritten({ map: 'Europe' })).toBeNull();
		expect(unwritten({ boundary: true })).toBeNull();
		expect(unwritten({ map: '' })).toBeNull();
		// a look long after the last says nothing of how the score went between
		expect(unwritten({ now: T0 + 120_000 })).toBeNull();
		const d = voteStep(server, 'rule', 'u1', cfg, look());
		expect(d.step?.do).toBe('open');
		// nothing moves until what it queues is written
		expect(voteOf(server)).toBeUndefined();
		d.commit();
		expect(voteOf(server)).toMatchObject({ phase: 'opening', map: 'Kavkazi', decidedAt: T0 });
		// one at a time; and with the score past, no other that match
		expect(step({ now: T0 + 5_000 })).toBeNull();
	});

	test('a look whose write fails is decided again at the next', () => {
		fresh();
		step({ now: T0 - 2_000, leading: 89 });
		expect(unwritten()?.do).toBe('open');
		expect(voteOf(server)).toBeUndefined();
		expect(step({ now: T0 + 2_000, leading: 91 })?.do).toBe('open');
	});

	test('an opening that never comes lapses, and no other vote opens that match', () => {
		fresh();
		decide();
		expect(step({ now: T0 + OPENING_MS - 1 })).toBeNull();
		expect(step({ now: T0 + OPENING_MS })?.do).toBe('lapsed');
		expect(voteOf(server)?.phase).toBe('done');
		expect(step({ now: T0 + OPENING_MS + 2_000, leading: 95 })).toBeNull();
		// the next match has its own, once its leader passes the score
		expect(step({ now: T0 + 600_000, map: 'Europe', leading: 3, boundary: true })).toBeNull();
		expect(voteOf(server)).toBeUndefined();
		expect(step({ now: T0 + 900_000, map: 'Europe', leading: 89 })).toBeNull();
		expect(step({ now: T0 + 902_000, map: 'Europe', leading: 90 })?.do).toBe('open');
	});

	test('votes count while it is open, a player’s last one, and only an option’s number', () => {
		fresh();
		decide();
		// not before the options are said
		expect(castBallot(server, 'rule', 'a', 1, T0)).toBe(false);
		const v = opened();
		expect(castBallot(server, 'other rule', 'a', 1, T0 + 2_000)).toBe(false);
		expect(castBallot(server, 'rule', 'a', 1, T0 + 2_000)).toBe(true);
		expect(castBallot(server, 'rule', 'a', 2, T0 + 3_000)).toBe(true);
		expect(castBallot(server, 'rule', 'b', 4, T0 + 3_000)).toBe(false);
		expect(castBallot(server, 'rule', 'b', 0, T0 + 3_000)).toBe(false);
		expect(castBallot(server, 'rule', '', 1, T0 + 3_000)).toBe(false);
		expect(castBallot(server, 'rule', 'b', 3, T0 + 3_000)).toBe(true);
		// not once its time is up
		expect(castBallot(server, 'rule', 'c', 1, v.closesAt)).toBe(false);
		expect([...v.ballots]).toEqual([
			['a', 2],
			['b', 3]
		]);
	});

	test('the votes so far halfway, once; then the result when its time is up', () => {
		fresh();
		decide();
		const v = opened();
		castBallot(server, 'rule', 'a', 2, T0 + 2_000);
		castBallot(server, 'rule', 'b', 2, T0 + 2_000);
		castBallot(server, 'rule', 'c', 3, T0 + 2_000);
		const half = (v.openedAt + v.closesAt) / 2;
		expect(step({ now: half - 1 })).toBeNull();
		expect(step({ now: half })).toMatchObject({ do: 'tally', counts: [0, 2, 1] });
		expect(step({ now: half + 1 })).toBeNull();
		const close = voteStep(server, 'rule', 'u1', cfg, look({ now: v.closesAt }), () => 0);
		expect(close.step).toMatchObject({
			do: 'close',
			counts: [0, 2, 1],
			total: 3,
			winner: 1,
			tied: false
		});
		// who voted is forgotten as the close is written
		expect(v.ballots.size).toBe(3);
		close.commit();
		expect(v.ballots.size).toBe(0);
		expect(v.phase).toBe('done');
		expect(step({ now: v.closesAt + 1_000 })).toBeNull();
	});

	test('no halfway text, no halfway step; too few votes, no winner', () => {
		fresh();
		const quiet = validateMapVote({ seconds: 60, tallyMessage: '', minVotes: 3 });
		step({ now: T0 - 2_000, leading: 89 }, 'u1', quiet);
		step({}, 'u1', quiet);
		const v = opened();
		castBallot(server, 'rule', 'a', 1, T0 + 2_000);
		castBallot(server, 'rule', 'b', 2, T0 + 2_000);
		expect(step({ now: (v.openedAt + v.closesAt) / 2 }, 'u1', quiet)).toBeNull();
		expect(step({ now: v.closesAt }, 'u1', quiet)).toMatchObject({
			do: 'close',
			total: 2,
			winner: null
		});
	});

	test('closes when the match is won, before its time is up', () => {
		fresh();
		decide();
		opened();
		castBallot(server, 'rule', 'a', 1, T0 + 2_000);
		expect(step({ now: T0 + 10_000, leading: 100 })).toMatchObject({ do: 'close', winner: 0 });
	});

	test('a new match while it is open ends it with nothing to apply', () => {
		fresh();
		decide();
		opened();
		castBallot(server, 'rule', 'a', 1, T0 + 2_000);
		expect(step({ now: T0 + 5_000, map: 'Europe', leading: 0 })).toMatchObject({
			do: 'ended',
			changed: false
		});
		expect(voteOf(server)).toBeUndefined();
		fresh();
		decide();
		opened();
		expect(step({ now: T0 + 5_000, boundary: true, leading: 2 })?.do).toBe('ended');
	});

	test('new settings drop the vote under way and open no other that match; a rename does not', () => {
		fresh();
		decide();
		opened();
		castBallot(server, 'rule', 'a', 1, T0 + 2_000);
		// the same settings (a rename, a save of the same): the vote goes on
		expect(step({ now: T0 + 3_000 })).toBeNull();
		expect(voteOf(server)?.ballots.size).toBe(1);
		expect(step({ now: T0 + 5_000 }, 'u2')).toMatchObject({ do: 'ended', changed: true });
		expect(voteOf(server)).toBeUndefined();
		expect(step({ now: T0 + 7_000 }, 'u2')).toBeNull();
	});

	test('the chat is read for the vote from a few points short of its score until it closes', () => {
		fresh();
		const at = (score: number) =>
			voteWantsChat(server, cfg, { scores: [{ score }, { score: 10 }] });
		expect([at(40), at(84), at(85), at(89), at(90), at(99)]).toEqual([
			false,
			false,
			true,
			true,
			false,
			false
		]);
		decide();
		// waiting to be opened, then open
		expect(at(91)).toBe(true);
		const v = opened();
		expect(at(95)).toBe(true);
		step({ now: v.closesAt });
		expect(at(96)).toBe(false);
		expect(voteWantsChat(server, cfg, null)).toBe(false);
	});

	test('a read of the chat counts for a while; forgetting a server forgets all of it', () => {
		fresh();
		expect(chatReadRecently(server, T0)).toBe(false);
		noteChatRead(server, T0);
		expect(chatReadRecently(server, T0 + READING_MS)).toBe(true);
		expect(chatReadRecently(server, T0 + READING_MS + 1)).toBe(false);
		decide();
		opened();
		castBallot(server, 'rule', 'a', 1, T0 + 2_000);
		forgetVotes(server);
		expect(voteOf(server)).toBeUndefined();
		expect(chatReadRecently(server, T0)).toBe(false);
		// and its last look: a pass needs a look under the score again
		expect(step({ now: T0 + 3_000, leading: 92 })).toBeNull();
	});
});

test('voteReplay: the first sample of each match at the score, with enough on', () => {
	const at = (ts: number, map: string, scores: number[], count = 40) => ({
		ts,
		ok: true,
		count,
		map,
		scores: scores.map((score, i) => ({ name: `F${i}`, score }))
	});
	const rows = [
		at(1, 'Kavkazi', [80, 50, 40]),
		at(2, 'Kavkazi', [90, 60, 40], 5), // too few on
		at(3, 'Kavkazi', [91, 61, 40]),
		at(4, 'Kavkazi', [95, 62, 40]),
		at(5, 'Kavkazi', [100, 62, 40]),
		{ ...at(6, 'Europe', [99, 0, 0]), ok: false },
		at(7, 'Europe', [10, 5, 0]),
		at(8, 'Europe', [92, 70, 60]),
		// the same map again: the scores fall back
		at(9, 'Europe', [1, 0, 0]),
		at(10, 'Europe', [90, 1, 0])
	];
	expect(voteReplay(rows, { startAt: 90, minPlayers: 10 }, 100)).toEqual([
		{ at: 3, map: 'Kavkazi', leading: 91, players: 40 },
		{ at: 8, map: 'Europe', leading: 92, players: 40 },
		{ at: 10, map: 'Europe', leading: 90, players: 40 }
	]);
});

// ---- the opening and the winner against the mock game ----

let clients = 0;
const clientFor = () =>
	new WardogsClient(
		{} as Env,
		{ id: `vote-client-${++clients}`, host: 'demo', port: 1, scheme: 'http' },
		'demo',
		`vote-test-${Date.now()}-${clients}`
	);
/** The rotation set through the document, the server on its first entry. */
async function setRotation(
	client: WardogsClient,
	entries: MapSelection[],
	{ mode = 'ordered', enabled = true } = {}
) {
	const doc = await readConfig(client);
	const text = rotationIntoText(doc.text, {
		enabled,
		mode: mode as 'random' | 'ordered',
		entries
	});
	expect((await client.configCall('PUT', '/v1/config', text, doc.revision)).status).toBe(200);
}
const live = (client: WardogsClient) =>
	client.json('GET', '/v1/rotation') as Promise<{
		entries: (MapSelection & { status: string })[];
	}>;
const onNow = async (client: WardogsClient) =>
	(await live(client)).entries.find((e) => e.status === 'now')!;
const upNext = async (client: WardogsClient) =>
	(await live(client)).entries.find((e) => e.status === 'next')!;
/** What the client said to the server, and how many times it wrote the document. */
function watch(client: WardogsClient) {
	const said: string[] = [];
	let puts = 0;
	const raw = client.raw.bind(client);
	client.raw = async (method, path, body, headers) => {
		if (method === 'POST' && path === '/v1/broadcast') said.push(JSON.parse(body ?? '{}').message);
		if (method === 'PUT' && path === '/v1/config') puts++;
		return raw(method, path, body, headers);
	};
	return { said, puts: () => puts };
}
const ROTATION = [
	entry('Kavkazi', ['Bakurani_KOTH_01'], 'ZoneAlternator.Kavkazi.A.Circle'),
	entry('Europe', ['Madrid_KOTH_01'], 'ZoneAlternator.Europe.A.Circle'),
	entry('NorthAmerica', ['Detroit_KOTH_01'], 'ZoneAlternator.NorthAmerica.A.Circle'),
	entry('Kavkazi', ['Bakurani_KOTH_01'], 'ZoneAlternator.Kavkazi.B.Circle'),
	entry('Europe', ['Madrid_KOTH_01'], 'ZoneAlternator.Europe.B.Circle')
];

describe('a vote on the mock game', () => {
	const was = process.env.MOCK_ROTATION_POINTER;
	afterEach(() => {
		if (was === undefined) delete process.env.MOCK_ROTATION_POINTER;
		else process.env.MOCK_ROTATION_POINTER = was;
		forgetVotes();
	});
	const cfg = validateMapVote({ seconds: 60 });
	let servers = 0;
	/** A server on its first entry, with its vote decided on and waiting in the outbox. */
	async function deciding(entries = ROTATION, rotation: { mode?: string; enabled?: boolean } = {}) {
		const client = clientFor();
		await setRotation(client, entries, rotation);
		const server = `mock-vote-${++servers}`;
		const at = Date.now();
		const base = { map: 'Kavkazi', cap: 100, players: 40, boundary: false, reading: true };
		voteStep(server, 'rule', 'u', cfg, { ...base, now: at - 2_000, leading: 89 }).commit();
		const d = voteStep(server, 'rule', 'u', cfg, { ...base, now: at, leading: 92 });
		expect(d.step?.do).toBe('open');
		d.commit();
		const params = {
			decidedAt: voteOf(server)!.decidedAt,
			options: cfg.options,
			seconds: cfg.seconds,
			text: 'Next map vote: {options}'
		};
		return { client, server, params };
	}
	const match = { map: 'Kavkazi', leading: 93, cap: 100 };

	test('opens with the maps from the rotation, said with their numbers', async () => {
		const { client, server, params } = await deciding();
		const { said } = watch(client);
		const r = await openVoteOnServer(client, server, params, match, () => 5_000);
		expect(r).toEqual({ message: 'Vote open for 60 s: Ozeti, Zestafona.' });
		expect(said).toEqual(['Next map vote: !1 Ozeti · !2 Zestafona']);
		expect(voteOf(server)).toMatchObject({ phase: 'open', openedAt: 5_000, closesAt: 65_000 });
		expect(voteOf(server)!.options.map((o) => o.index)).toEqual([1, 2]);
	});

	test('a rotation that is off, Random, or without two other maps: no vote, said so, once', async () => {
		for (const [entries, rotation, words] of [
			[ROTATION, { enabled: false }, 'switched off'],
			[ROTATION, { mode: 'random' }, 'Random'],
			[[ROTATION[0], ROTATION[1], ROTATION[3]], {}, 'fewer than two maps other than']
		] as const) {
			const { client, server, params } = await deciding([...entries], rotation);
			const { said } = watch(client);
			const err = await openVoteOnServer(client, server, params, match).catch((e) => e);
			expect(err).toBeInstanceOf(ApiError);
			expect(String(err.message)).toContain(words);
			expect(said).toEqual([]);
			expect(voteOf(server)?.phase).toBe('done');
		}
	});

	test('a match that ended, or a vote called off, before it is sent: skipped', async () => {
		const a = await deciding();
		expect(
			await openVoteOnServer(a.client, a.server, a.params, { ...match, map: 'Europe' })
		).toMatchObject({ skipped: true });
		expect(voteOf(a.server)?.phase).toBe('done');
		const b = await deciding();
		expect(
			await openVoteOnServer(b.client, b.server, b.params, { ...match, leading: 100 })
		).toMatchObject({
			skipped: true
		});
		const c = await deciding();
		expect(
			await openVoteOnServer(c.client, c.server, { ...c.params, decidedAt: 1 }, match)
		).toMatchObject({ skipped: true, message: 'The vote was called off before it opened.' });
	});

	/** A vote opened, the votes cast, closed: what the evaluation would queue for its winner. */
	async function won(choice: number, voters = 3, entries = ROTATION) {
		const d = await deciding(entries);
		await openVoteOnServer(d.client, d.server, d.params, match);
		const v = voteOf(d.server)!;
		for (let i = 0; i < voters; i++) castBallot(d.server, 'rule', `p${i}`, choice, Date.now());
		const decided = voteStep(d.server, 'rule', 'u', cfg, {
			now: v.closesAt,
			map: 'Kavkazi',
			leading: 95,
			cap: 100,
			players: 40,
			boundary: false,
			reading: true
		});
		decided.commit();
		const close = decided.step;
		if (close?.do !== 'close' || close.winner === null) throw new Error('no winner');
		const option = v.options[close.winner];
		return {
			...d,
			option,
			params: {
				map: 'Kavkazi',
				on: v.on,
				index: option.index,
				entry: option.entry,
				votes: close.counts[close.winner],
				total: close.total,
				message: 'Winner next!'
			}
		};
	}

	for (const pointer of ['entry', 'index', 'top']) {
		test(`the winner is next, and plays at the next map change (pointer: ${pointer})`, async () => {
			const { client, params, option } = await won(2);
			process.env.MOCK_ROTATION_POINTER = pointer;
			const { said, puts } = watch(client);
			const r = await applyVoteOnServer(client, params, match);
			expect(r.message).toBe('Zestafona won with 3 of 3 votes and is next; said to the server.');
			expect(said).toEqual(['Winner next!']);
			// at most once more, where the server says it goes next
			expect(puts()).toBe(pointer === 'top' ? 2 : 1);
			expect(await upNext(client)).toMatchObject(option.entry);
			// every entry is still there, once each
			const doc = rotationFromText((await readConfig(client)).text);
			expect(doc.mode).toBe('ordered');
			expect(doc.entries.map((e) => JSON.stringify(e)).sort()).toEqual(
				ROTATION.map((e) => JSON.stringify(e)).sort()
			);
			await client.json('POST', '/v1/match/end');
			expect(await onNow(client)).toMatchObject(option.entry);
		});
	}

	test('the entry already next wins: nothing written, the result said', async () => {
		const { client, params } = await won(1);
		const { said, puts } = watch(client);
		const r = await applyVoteOnServer(client, params, match);
		expect(r.message).toBe(
			'Ozeti won with 3 of 3 votes, and was next already; said to the server.'
		);
		expect(puts()).toBe(0);
		expect(said).toEqual(['Winner next!']);
	});

	test('the next match already started: skipped, nothing written', async () => {
		const { client, params } = await won(2);
		const { said, puts } = watch(client);
		const r = await applyVoteOnServer(client, params, { ...match, map: 'Europe' });
		expect(r).toMatchObject({ skipped: true });
		expect([puts(), said.length]).toEqual([0, 0]);
	});

	test('a rotation changed since the vote opened: refused in the panel’s words', async () => {
		const { client, params } = await won(2);
		// the winning entry is gone from the rotation
		await setRotation(client, [ROTATION[0], ROTATION[1], ROTATION[3]]);
		const { said } = watch(client);
		const err = await applyVoteOnServer(client, params, match).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.message).toBe('Zestafona not put next: the rotation no longer has its entry.');
		expect(said).toEqual([]);
		// switched to Random meanwhile
		const b = await won(2);
		await setRotation(b.client, ROTATION, { mode: 'random' });
		const err2 = await applyVoteOnServer(b.client, b.params, match).catch((e) => e);
		expect(String(err2.message)).toContain('set to Random');
	});

	test('a document without the winning entry is not written', async () => {
		const { client, params } = await won(2);
		const raw = client.raw.bind(client);
		let puts = 0;
		client.raw = async (method, path, body, headers) => {
			const res = await raw(method, path, body, headers);
			if (method === 'PUT' && path === '/v1/config') puts++;
			if (method === 'GET' && path === '/v1/config') {
				// the file holds another list than the one the server plays: no Zestafona in it
				const doc = JSON.parse(res.text);
				const r = rotationFromText(doc.text);
				doc.text = rotationIntoText(doc.text, {
					...r,
					entries: r.entries.filter((e) => e.map !== 'NorthAmerica')
				});
				return { ...res, text: JSON.stringify(doc) };
			}
			return res;
		};
		const err = await applyVoteOnServer(client, params, match).catch((e) => e);
		expect(err.message).toBe(
			'Zestafona not put next: the rotation in the config document does not have its entry.'
		);
		expect(puts).toBe(0);
	});

	test('the server on another entry of the same map by then: that match is over, skipped', async () => {
		// two Bakurani matches in a row: the vote on the first is no vote on the second
		const twice = [
			entry('Kavkazi', ['Bakurani_KOTH_01'], 'ZoneAlternator.Kavkazi.A.Circle'),
			entry('Kavkazi', ['Bakurani_KOTH_01'], 'ZoneAlternator.Kavkazi.B.Circle'),
			entry('Europe', ['Madrid_KOTH_01'], 'ZoneAlternator.Europe.A.Circle'),
			entry('NorthAmerica', ['Detroit_KOTH_01'], 'ZoneAlternator.NorthAmerica.A.Circle')
		];
		const { client, params } = await won(2, 3, twice);
		await client.json('POST', '/v1/match/end');
		const { said, puts } = watch(client);
		const r = await applyVoteOnServer(client, params, match);
		expect(r).toEqual({
			skipped: true,
			message: 'The next match started before Zestafona could be put next.'
		});
		expect([puts(), said.length]).toEqual([0, 0]);
	});

	test('a result the server will not take for sending too fast still stands, and holds the server', async () => {
		const { client, params, option } = await won(2);
		const raw = client.raw.bind(client);
		client.raw = async (method, path, body, headers) =>
			method === 'POST' && path === '/v1/broadcast'
				? {
						status: 429,
						statusText: 'Too Many Requests',
						headers: { 'content-type': 'application/json', 'retry-after': '4' },
						text: JSON.stringify({ ok: false, error: { code: 'rate_limited', message: 'slow' } })
					}
				: raw(method, path, body, headers);
		const r = await applyVoteOnServer(client, params, match);
		expect(r.message).toBe(
			'Zestafona won with 3 of 3 votes and is next; the result was not said: the server asked the panel to slow down.'
		);
		expect(r.retryAfterMs).toBe(4_000);
		expect(await upNext(client)).toMatchObject(option.entry);
	});
});
