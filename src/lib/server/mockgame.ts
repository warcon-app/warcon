// An in-process imitation of the WARDOGS dedicated server's WDRCON HTTP API.
// Used when a server is added with host "demo" (and ALLOW_DEMO_SERVER is on) so the whole
// panel can be exercised without a game server. State lives in process memory and resets
// on restart, which is fine for a demo.
//
// Route shapes mirror what rcon.wardogs.com's js/api.js expects from a real server.

import { createHash } from 'node:crypto';
import type { GameResponse } from './transport';
import { rotationFromText } from '../rotation-doc';
import { getScalar, parseIni } from '../config-doc';
import {
	hasReservedKey,
	reservedFromText,
	reservedIntoText,
	reservedSlotsHeld
} from '../reserved-doc';

export const MOCK_PASSWORD = 'demo';

interface Player {
	name: string;
	steamId: string;
	faction: string;
	kills: number;
	deaths: number;
	cash: number;
	pingMs: number;
}
interface Ban {
	steamId: string;
	bannedAtUtc: string;
	bannedBy: string;
	reason: string | null;
}
interface Entry {
	map: string;
	experiences: string[];
	lighting: string;
	zoneAlternator: string;
	denied: boolean;
}
interface AuditEntry {
	timestampUtc: string;
	peer: string;
	sessionId: string;
	event: string;
	detail: string;
}

interface State {
	serverName: string;
	maxPlayers: number;
	scoreTick: number;
	scoreCap: number;
	factions: { name: string; colorHex: string; score: number; rate: number }[];
	current: { map: string; experiences: string[]; lighting: string; alternator: string };
	players: Player[];
	bans: Ban[];
	reserved: string[];
	sponsorUrl: string;
	rotation: {
		enabled: boolean;
		mode: 'ordered' | 'random';
		nowIndex: number;
		nextIndex: number;
		entries: Entry[];
	};
	audit: AuditEntry[];
	matchStart: number;
	lastScoreAt: number;
	nextJoiner: number;
	configText: string;
	configRevision: number;
	/** events since the last drain, as the game's feed would post them (feed-events.ts) */
	feed: Record<string, unknown>[];
	/** the match state the feed last reported (feedState); '' until the first tick, which reports
	 *  one as a game does when it starts */
	matchState: string;
	/** the game's id for the match in progress, on the feed's events */
	matchId: string;
	/** when the game process started (ms): what GET /v1/health counts its uptime from */
	startedAt: number;
	/** what GET /v1/feed reports (setMockFeed); null: a feed that is off */
	feedReport: Record<string, unknown> | null;
}

const MAPS = [
	{ id: 'Kavkazi', displayName: 'Bakurani' },
	{ id: 'Europe', displayName: 'Ozeti' },
	{ id: 'NorthAmerica', displayName: 'Zestafona' }
];
const EXPERIENCES = [
	{ id: 'Bakurani_KOTH_01', displayName: 'King of the Hill' },
	{ id: 'Madrid_KOTH_01', displayName: 'King of the Hill' },
	{ id: 'Detroit_KOTH_01', displayName: 'King of the Hill' },
	{ id: 'KOTH_InfantryOnly', displayName: 'Infantry' },
	{ id: 'KOTH_Hardcore', displayName: 'Hardcore' }
];
const EXPERIENCES_BY_MAP: Record<string, string[]> = {
	Kavkazi: ['Bakurani_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore'],
	Europe: ['Madrid_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore'],
	NorthAmerica: ['Detroit_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore']
};
const LIGHTINGS = [
	'DayStartClear',
	'DayEarlyClear',
	'DayEarlyFog',
	'DayClear',
	'DayLateClear',
	'DayLateGray',
	'DayLateGrayFog',
	'DayEndClear',
	'DayLateRain'
].map((id) => ({ id, displayName: id.replace(/([a-z])([A-Z])/g, '$1 $2') }));
const ALTERNATORS_BY_MAP: Record<string, { tag: string; displayName: string }[]> = {
	Kavkazi: [
		{ tag: 'ZoneAlternator.Factory.Circle', displayName: 'Bakurani Factory Circle' },
		{ tag: 'ZoneAlternator.Factory.Split', displayName: 'Bakurani Factory Split' }
	]
};
const JOINERS = [
	'Copperhead',
	'Late_to_the_party',
	'VelvetThunder',
	'Brick',
	'Saltmine',
	'Ostrich Wrangler',
	'0xDEADBEEF',
	'Pretty Average',
	'Whistler',
	'Junkrat Jane'
];

// Routes live builds CL-499480 (2026-09-11) and CL-501228 (2026-09-14) do not serve. With
// MOCK_LIVE_BUILD=true the demo servers drop them too, pin ServerName and Port like the TLR host,
// and report the live build string, so that build's behaviour can be exercised without a real server.
const LIVE_BUILD_MISSING = new Set([
	'POST /v1/reserved-slots',
	'DELETE /v1/reserved-slots/{steamId}',
	'POST /v1/rotation/entries',
	'DELETE /v1/rotation/entries/{index}',
	'POST /v1/rotation/entries/{index}/move',
	'POST /v1/rotation/save',
	'PATCH /v1/settings',
	// Season 2 (CL-516586) on
	'GET /v1/feed'
]);
const liveBuild = () => /^(1|true|yes)$/i.test(process.env.MOCK_LIVE_BUILD || '');
// With MOCK_LIVE_ADDS=now as well, a slot added to the document is reserved at once while one taken
// out stays until a restart: what a live server was seen doing once (2026-09-15). Unset, both wait.
const liveAddsNow = () => liveBuild() && /^now$/i.test(process.env.MOCK_LIVE_ADDS || '');
/** The listener's limit on a request body, which it reports under limits.maxBodyBytes. */
const MAX_BODY_BYTES = 65536;
// With MOCK_PREMATCH=true a demo match waits at nil-all while fewer are on than the document's
// MinimumRequiredPlayers (60), as the game's pre-match does, and a new demo server starts there:
// AFK protection can be watched at work, and lowering the minimum starts the match.
const prematch = () => /^(1|true|yes)$/i.test(process.env.MOCK_PREMATCH || '');
const PREMATCH_MINIMUM = 60;
// With MOCK_STARTUP_MAP=true a demo server comes up on standard Bakurani at a time of day its
// rotation does not have, and goes to the top of the rotation only once that match ends, as hosts
// report live servers doing since Season 2 (the Skip map after restart rule ends that match).
const startupMap = () => /^(1|true|yes)$/i.test(process.env.MOCK_STARTUP_MAP || '');
const STARTUP_MAP = { map: 'Kavkazi', experiences: ['Bakurani_KOTH_01'], lighting: 'DayClear' };
// With MOCK_AFK=true a new demo server has one more player, who sits in spawn on a macro: never a
// kill, a death or a dollar; and a match runs ten times as long (half an hour, nearer a real one), so
// an AFK watch rule can be watched at work before the match ends and starts every clock again.
const afkPlayer = () => /^(1|true|yes)$/i.test(process.env.MOCK_AFK || '');
const AFK_PLAYER = '76561198100000150';
// The match states the demo's feed reports (match_state events): a new match starts in pre-match,
// waits there below the minimum under MOCK_PREMATCH, plays, and ends (with match_ended first).
// Pre-match carries no match id, as on the game: it has none until the world has loaded.
const PRE_MATCH = 'MatchState.PreMatch';
const WAITING = 'MatchState.PreMatch.WaitingForPlayers.PlayerCount';
const PLAYING = 'MatchState.Playing.KOTH';
const POST_MATCH = 'MatchState.PostMatch';
// Where the rotation's pointer goes when the document rewrites it, which no live build has been
// seen doing: by default it stays on the entry now playing; MOCK_ROTATION_POINTER=index keeps the
// place it had, =top goes to the top of the list at the next map change.
const rotationPointer = () =>
	/^(index|top)$/i.test(process.env.MOCK_ROTATION_POINTER || '')
		? (process.env.MOCK_ROTATION_POINTER as string).toLowerCase()
		: 'entry';
const prematchMinimum = (text: string): number => {
	const n = Number(
		getScalar(
			parseIni(text),
			'MatchState.PreMatch.WaitingForPlayers.PlayerCount',
			'MinimumRequiredPlayers'
		)
	);
	return Number.isInteger(n) && n >= 0 ? n : PREMATCH_MINIMUM;
};
const servedRoutes = () =>
	liveBuild() ? CAPABILITY_ROUTES.filter((r) => !LIVE_BUILD_MISSING.has(r)) : CAPABILITY_ROUTES;

const CAPABILITY_ROUTES = [
	'GET /v1/capabilities',
	'GET /v1/health',
	'GET /v1/server-id',
	'GET /v1/status',
	'GET /v1/players',
	'POST /v1/players/{steamId}/kick',
	'POST /v1/players/{steamId}/kill',
	'POST /v1/players/{steamId}/message',
	'PATCH /v1/players/{steamId}',
	'GET /v1/bans',
	'POST /v1/bans',
	'DELETE /v1/bans/{steamId}',
	'POST /v1/broadcast',
	'GET /v1/catalog/maps',
	'GET /v1/catalog/lightings',
	'GET /v1/catalog/experiences',
	'GET /v1/catalog/maps/{map}/experiences',
	'GET /v1/catalog/maps/{map}/alternators',
	'POST /v1/match/map',
	'POST /v1/match/end',
	'POST /v1/match/restart',
	'PUT /v1/world/lighting',
	'GET /v1/rotation',
	'POST /v1/rotation/entries',
	'DELETE /v1/rotation/entries/{index}',
	'POST /v1/rotation/entries/{index}/move',
	'POST /v1/rotation/save',
	'PATCH /v1/settings',
	'GET /v1/reserved-slots',
	'POST /v1/reserved-slots',
	'DELETE /v1/reserved-slots/{steamId}',
	'GET /v1/sponsor',
	'GET /v1/audit',
	'GET /v1/config',
	'POST /v1/config/validate',
	'PUT /v1/config',
	'GET /v1/feed'
];

// The schema live build CL-501228 reports from GET /v1/config (captured 2026-09-14; CL-499480's
// was the same minus bWriteAuditLogFile and the per-key writable/lockedBy flags).
const CONFIG_SECTIONS = [
	{
		section: '/Script/WDGame.WDGameSession',
		appliesWhen: 'applied',
		description: 'Server identity, bans, reserved slots and the sponsor banner.',
		allowedKeys: [
			'DefaultBannedPlayerIds',
			'DefaultReservedPlayerIds',
			'MaxReservedSlots',
			'PlayerIdentityEntries',
			'ServerImageURL',
			'ServerMaxPlayerCash',
			'ServerMaxPlayerLevel',
			'ServerMinPlayerCash',
			'ServerMinPlayerLevel',
			'ServerName',
			'ServerPassword'
		],
		keyOverrides: [
			{
				key: 'ServerPassword',
				appliesWhen: 'applied',
				description:
					'Sent on the session update this apply triggers, so it gates new joins at once. Players already in are not rechecked.'
			},
			...[
				'ServerMinPlayerCash',
				'ServerMaxPlayerCash',
				'ServerMinPlayerLevel',
				'ServerMaxPlayerLevel'
			].map((key) => ({
				key,
				appliesWhen: 'applied',
				description:
					'Sent on the session update this apply triggers, so new joins are checked against it at once. Players already connected are not re-checked or removed.'
			})),
			{
				key: 'ServerImageURL',
				appliesWhen: 'pending',
				description: 'Fetched and validated off-thread before the banner is advertised.'
			}
		]
	},
	{
		section: '/Script/Engine.GameSession',
		appliesWhen: 'next-restart',
		description:
			'Player slot count. Not applied to a running server by choice, so a change takes effect on restart.',
		allowedKeys: ['MaxPlayers'],
		keyOverrides: []
	},
	{
		section: '/Script/WDGame.WDGameStateSession',
		appliesWhen: 'next-match',
		description:
			'Team balance rules. The running match keeps its current values; the config values are read when a match starts.',
		allowedKeys: ['bLockOverpopulatedTeamsConfig', 'OverpopulatedTeamThresholdConfig'],
		keyOverrides: []
	},
	{
		section: '/Script/WDGame.WDServerMapRotationSettings',
		appliesWhen: 'applied',
		description: 'Map rotation order and mode. Rebuilt immediately; used from the next map change.',
		allowedKeys: ['bEnabled', 'RotationEntries', 'RotationMode'],
		keyOverrides: []
	},
	{
		section: 'MatchState.Playing.KOTH',
		appliesWhen: 'next-match',
		description:
			'KOTH scoring. The match in progress keeps its current values; scoring cadence never changes mid-round.',
		allowedKeys: ['ScorePeriod'],
		keyOverrides: []
	},
	{
		section: 'MatchState.PreMatch.WaitingForPlayers.PlayerCount',
		appliesWhen: 'next-match',
		description: 'Minimum players before a match starts. Read when the next pre-match begins.',
		allowedKeys: ['MinimumRequiredPlayers'],
		keyOverrides: []
	},
	{
		section: '/Script/WDRCON.WDRCONSettings',
		appliesWhen: 'next-restart',
		description: 'RCON listener. Written now, read at startup.',
		allowedKeys: [
			'AllowedOrigins',
			'bEnabled',
			'BindAddress',
			'bWriteAuditLogFile',
			'Password',
			'PasswordHash',
			'Port'
		],
		keyOverrides: []
	},
	{
		section: 'WDServerFeed',
		appliesWhen: 'next-restart',
		description: 'Kill-event feed endpoint and its ingest token. Written now, read at startup.',
		allowedKeys: ['Token', 'Url'],
		keyOverrides: []
	}
];

function utc(date = new Date()): string {
	return date
		.toISOString()
		.replace('T', ' ')
		.replace(/\.\d+Z$/, 'Z');
}

function seed(name: string): State {
	const now = Date.now();
	const mk = (
		n: string,
		id: string,
		f: string,
		k: number,
		d: number,
		c: number,
		p: number
	): Player => ({ name: n, steamId: id, faction: f, kills: k, deaths: d, cash: c, pingMs: p });
	const state: State = {
		serverName: name,
		maxPlayers: 32,
		scoreTick: 24,
		scoreCap: 100,
		factions: [
			{ name: 'Valkyra', colorHex: '#D86060', score: 34, rate: 0.55 },
			{ name: 'Lonestar', colorHex: '#5B95D8', score: 27, rate: 0.42 },
			{ name: 'Manticore', colorHex: '#7BC462', score: 30, rate: 0.48 }
		],
		current: {
			map: 'Kavkazi',
			experiences: ['Bakurani_KOTH_01'],
			lighting: 'DayLateClear',
			alternator: 'ZoneAlternator.Factory.Circle'
		},
		players: [
			mk('Ghostpepper', '76561198100000101', 'Valkyra', 14, 6, 5200, 31),
			mk('Mad Marmalade', '76561198100000102', 'Valkyra', 9, 11, 3100, 48),
			mk('T0XIC_AVENGER', '76561198100000103', 'Valkyra', 6, 4, 2650, 22),
			mk('Nomad', '76561198100000105', 'Lonestar', 17, 8, 6800, 27),
			mk('Willowisp', '76561198100000106', 'Lonestar', 11, 10, 4100, 64),
			mk('KillustratorPro', '76561198100000107', 'Lonestar', 8, 5, 3300, 41),
			mk('QuietStorm', '76561198100000109', 'Manticore', 13, 7, 5000, 33),
			mk('Dutchie', '76561198100000110', 'Manticore', 10, 10, 3800, 55),
			mk('Rooikat', '76561198100000111', 'Manticore', 7, 3, 2900, 73),
			...(afkPlayer() ? [mk('Sleepwalker', AFK_PLAYER, 'Lonestar', 0, 0, 0, 45)] : [])
		],
		bans: [
			{
				steamId: '76561198100000301',
				bannedAtUtc: '2026-08-09 21:14:02Z',
				bannedBy: 'joe',
				reason: 'Cheating - aimbot'
			},
			{
				steamId: '76561198100000302',
				bannedAtUtc: '2026-08-10 09:41:55Z',
				bannedBy: 'console',
				reason: 'Griefing teammates'
			}
		],
		reserved: ['76561198100000201', '76561198100000202'],
		sponsorUrl: 'https://i.postimg.cc/5N5ynGcY/Server-Browser-Image.jpg',
		rotation: {
			enabled: true,
			mode: 'ordered',
			nowIndex: 0,
			nextIndex: 1,
			entries: [
				{
					map: 'Kavkazi',
					experiences: ['Bakurani_KOTH_01'],
					lighting: 'DayLateClear',
					zoneAlternator: 'ZoneAlternator.Factory.Circle',
					denied: false
				},
				{
					map: 'Europe',
					experiences: ['KOTH_InfantryOnly'],
					lighting: 'DayEarlyFog',
					zoneAlternator: '',
					denied: false
				},
				{
					map: 'NorthAmerica',
					experiences: ['Detroit_KOTH_01'],
					lighting: 'DayEndClear',
					zoneAlternator: '',
					denied: false
				}
			]
		},
		audit: [
			{
				timestampUtc: utc(new Date(now - 45 * 60000)),
				peer: '127.0.0.1:51022',
				sessionId: '9f3ab1c2',
				event: 'ACCEPT',
				detail: '-'
			},
			{
				timestampUtc: utc(new Date(now - 44 * 60000)),
				peer: '127.0.0.1:51022',
				sessionId: '9f3ab1c2',
				event: 'AUTH_FAIL',
				detail: 'bad password'
			},
			{
				timestampUtc: utc(new Date(now - 43 * 60000)),
				peer: '127.0.0.1:51022',
				sessionId: '9f3ab1c2',
				event: 'AUTH_OK',
				detail: '-'
			},
			{
				timestampUtc: utc(new Date(now - 25 * 60000)),
				peer: '127.0.0.1:51022',
				sessionId: '9f3ab1c2',
				event: 'COMMAND',
				detail: 'changemap Kavkazi Bakurani_KOTH_01 DayLateClear'
			},
			{
				timestampUtc: utc(new Date(now - 12 * 60000)),
				peer: '127.0.0.1:51139',
				sessionId: 'c41d09aa',
				event: 'REJECT',
				detail: 'rate limited'
			}
		],
		matchStart: now - (105 * 60 + 12) * 1000,
		lastScoreAt: now,
		nextJoiner: 0,
		configText: '',
		configRevision: 1,
		feed: [],
		matchState: '',
		matchId: crypto.randomUUID(),
		startedAt: STARTED,
		feedReport: null
	};
	state.configText = seedConfig(state);
	return state;
}

/**
 * What the demo's GET /v1/feed reports from now on, as Season 2's (for tests): the demo's own feed
 * is drained by the worker (feed-events.ts) and posts nowhere, so by default it reports a feed
 * that is off.
 */
export function setMockFeed(key: string, report: Record<string, unknown> | null): void {
	stateFor(key).feedReport = report;
}

/** Player slots open to the public: MaxPlayers less what MaxReservedSlots holds back. */
const publicSlots = (s: State): number =>
	Math.max(0, s.maxPlayers - (reservedSlotsHeld(s.configText) ?? 0));

function seedConfig(s: State): string {
	return [
		'[/Script/WDGame.WDGameSession]',
		`ServerName=${s.serverName}`,
		'ServerPassword=',
		`ServerImageURL=${s.sponsorUrl}`,
		// Two of MaxPlayers held back for reserved players, as on the TLR server (98+2 of 100).
		'MaxReservedSlots=2',
		// The live build serialises arrays as a clear followed by one line per value.
		'!DefaultReservedPlayerIds=ClearArray',
		...s.reserved.map((id) => `.DefaultReservedPlayerIds=${id}`),
		...s.bans.map((b) => `+DefaultBannedPlayerIds="${b.steamId}"`),
		'',
		'[/Script/Engine.GameSession]',
		`MaxPlayers=${s.maxPlayers}`,
		'',
		'[MatchState.PreMatch.WaitingForPlayers.PlayerCount]',
		'MinimumRequiredPlayers=60',
		'',
		'[MatchState.Playing.KOTH]',
		`ScorePeriod=${s.scoreTick}`,
		'',
		'[/Script/WDGame.WDGameStateSession]',
		'bLockOverpopulatedTeamsConfig=true',
		'OverpopulatedTeamThresholdConfig=2',
		'',
		'[/Script/WDGame.WDServerMapRotationSettings]',
		`bEnabled=${s.rotation.enabled ? 'true' : 'false'}`,
		`RotationMode=${s.rotation.mode === 'random' ? 'Random' : 'Ordered'}`,
		...s.rotation.entries.map(
			(e) =>
				`+RotationEntries=(Map="${e.map}",Experiences="${e.experiences.join('+')}",Lighting="${e.lighting}"${e.zoneAlternator ? `,ZoneAlternator="${e.zoneAlternator}"` : ''})`
		),
		'',
		'[/Script/WDRCON.WDRCONSettings]',
		'bEnabled=true',
		'BindAddress=0.0.0.0',
		'Port=7776',
		'bWriteAuditLogFile=false',
		''
	].join('\r\n');
}

/**
 * The schema with the two launch-argument locks the TLR host runs with on live build CL-501228
 * (ServerName by -RCON_FixedServerName, Port by -RCONPort): `writable: false` plus `lockedBy`.
 * Only under MOCK_LIVE_BUILD, so the plain demo stays fully editable.
 */
function configSections(): typeof CONFIG_SECTIONS {
	if (!liveBuild()) return CONFIG_SECTIONS;
	const pin = (key: string, lockedBy: string, appliesWhen: string) => ({
		key,
		appliesWhen,
		description: `Pinned by -${lockedBy} on this server's command line. The value is shown but cannot be changed here.`,
		writable: false,
		lockedBy
	});
	return CONFIG_SECTIONS.map((c) =>
		c.section === '/Script/WDGame.WDGameSession'
			? {
					...c,
					keyOverrides: [...c.keyOverrides, pin('ServerName', 'RCON_FixedServerName', 'applied')]
				}
			: c.section === '/Script/WDRCON.WDRCONSettings'
				? { ...c, keyOverrides: [...c.keyOverrides, pin('Port', 'RCONPort', 'next-restart')] }
				: c
	);
}

const states = new Map<string, State>();
const STARTED = Date.now();

/** A uuid-shaped id derived from the demo key, so it survives a state reset but differs per server. */
function demoServerId(key: string): string {
	const h = createHash('sha1').update(`warcon-demo:${key}`).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The game process restarting (not a match restart), at `at` (now by default): its uptime counts
 * from then, the running reserved list is read again from the document, as a live server does at
 * start, and under MOCK_STARTUP_MAP it comes up on the start-up map. For tests.
 */
export function restartMock(key: string, at = Date.now()): void {
	const s = stateFor(key);
	s.startedAt = at;
	s.reserved = reservedFromText(s.configText).filter((id) => /^\d{17}$/.test(id));
	if (startupMap()) comeUp(s);
}

/** A new match on the start-up map, off the rotation, with the top of the rotation next. */
function comeUp(s: State): void {
	s.current = { ...STARTUP_MAP, experiences: [...STARTUP_MAP.experiences], alternator: '' };
	s.rotation.nowIndex = -1;
	s.rotation.nextIndex = s.rotation.entries.length ? nextPlayable(s, -1) : -1;
	resetScores(s);
}

function stateFor(key: string): State {
	let s = states.get(key);
	if (!s) {
		s = seed(`Warcon Demo Server [${key.slice(0, 6)}]`);
		if (startupMap()) comeUp(s);
		if (prematch()) for (const f of s.factions) f.score = 0;
		states.set(key, s);
	}
	return s;
}

function tick(s: State): void {
	const now = Date.now();
	const dt = (now - s.lastScoreAt) / 1000;
	s.lastScoreAt = now;
	const waiting =
		prematch() &&
		s.factions.every((f) => f.score === 0) &&
		s.players.length < prematchMinimum(s.configText);
	feedState(s, waiting ? WAITING : PLAYING);
	if (!waiting)
		for (const f of s.factions) {
			f.score += f.rate * (afkPlayer() ? 0.1 : 1) * dt * (0.8 + Math.random() * 0.4);
		}
	if (s.factions.some((f) => f.score >= s.scoreCap)) {
		matchOver(s);
	}
	// the AFK player under MOCK_AFK neither kills nor is killed
	const fighting = s.players.filter((p) => p.steamId !== AFK_PLAYER);
	for (const p of s.players) {
		if (p.steamId !== AFK_PLAYER && Math.random() < 0.05) {
			p.kills++;
			p.cash += 150;
			const v = fighting[Math.floor(Math.random() * fighting.length)];
			if (v !== p) {
				v.deaths++;
			}
			feedKill(s, p, v);
		}
		p.pingMs = Math.max(5, p.pingMs + Math.floor(Math.random() * 9) - 4);
	}
	// One of the drifters leaves now and then once the server is busy, so a full demo server keeps
	// turning over (the seeded regulars stay, so tests can rely on them).
	if (s.players.length > 8 && Math.random() < 0.03) {
		const drifters = s.players.filter((p) => BigInt(p.steamId) >= 76561198100000401n);
		if (drifters.length) {
			const gone = drifters[Math.floor(Math.random() * drifters.length)];
			s.players.splice(s.players.indexOf(gone), 1);
			log(s, 'CLOSE', `${gone.name} disconnected`);
			feedPresence(s, 'player_left', gone);
		}
	}
	// Someone new drifts in now and then; quicker while the server is quiet, so joins (and the
	// triggers that watch for them) are easy to see on the demo.
	if (s.players.length < 16 && Math.random() < (s.players.length < 12 ? 0.2 : 0.04)) {
		const p: Player = {
			name: JOINERS[s.nextJoiner % JOINERS.length],
			steamId: String(76561198100000401n + BigInt(s.nextJoiner++)),
			faction: s.factions[Math.floor(Math.random() * s.factions.length)].name,
			kills: 0,
			deaths: 0,
			cash: 0,
			pingMs: 20 + Math.floor(Math.random() * 90)
		};
		s.players.push(p);
		feedPresence(s, 'player_joined', p);
	}
}

const FEED_CAUSES = [
	'Id.Item.AK74M',
	'Id.Item.WEPN_029',
	'Id.Item.Mosin',
	'Id.Item.SKS',
	'Id.Item.SVDM',
	'Id.Item.M4',
	'Id.Item.M67Grenade',
	'Id.Vehicle.WeaponExtension.STN_03.MainBarrel',
	'Vehicle.Variant.Air.Rotary.Littlebird.Default'
];
/** Queues an event with the fields the game's feed puts on every one (docs/wardogs-api.md). */
function feedEvent(s: State, e: { type: string } & Record<string, unknown>): void {
	s.feed.push({
		eventId: crypto.randomUUID().toUpperCase(),
		eventTime: (Date.now() - s.matchStart) / 1000,
		matchId: s.matchId,
		mapName: s.current.map,
		...e
	});
	if (s.feed.length > 50) s.feed.splice(0, s.feed.length - 50);
}

/** Queues the kill the way the game's feed reports one. */
function feedKill(s: State, killer: Player, victim: Player): void {
	const suicide = killer === victim;
	const cause = FEED_CAUSES[Math.floor(Math.random() * FEED_CAUSES.length)];
	const headshot = !suicide && Math.random() < 0.25;
	feedEvent(s, {
		type: 'killed',
		killerName: killer.name,
		killerId: '-demo',
		killerSteamId: killer.steamId,
		victimName: victim.name,
		victimId: '-demo',
		victimSteamId: victim.steamId,
		cause: suicide ? undefined : cause,
		distance: suicide ? undefined : Math.round(300 + Math.random() * 30000),
		contextTags: [
			...(headshot ? ['Meta.Progression.Context.Player.KillContext.Headshot'] : []),
			...(suicide ? ['Meta.PlayerKillFlag.Player.Suicide'] : []),
			'Meta.PlayerKillFlag.Player.Local.Kill',
			'Meta.PlayerKillFlag.Player.Local.Death'
		]
	});
}

/** A player joining or leaving as Season 2's feed reports it, with the count after. */
function feedPresence(s: State, type: 'player_joined' | 'player_left', p: Player): void {
	feedEvent(s, {
		type,
		playerName: p.name,
		playerId: '-demo',
		playerSteamId: p.steamId,
		players: s.players.length
	});
}

/** The match's state when it moves on, as Season 2's feed reports it. */
function feedState(s: State, state: string): void {
	if (s.matchState === state) return;
	s.matchState = state;
	feedEvent(s, {
		type: 'match_state',
		state,
		...(state === PRE_MATCH ? { matchId: undefined } : {})
	});
}

/** The match's result as Season 2's feed reports it: the leader wins, scores as the board shows them. */
function feedResult(s: State): void {
	const scores = s.factions.map((f) => ({
		faction: f.name,
		score: Math.min(s.scoreCap, Math.floor(f.score))
	}));
	const top = [...s.factions].sort((a, b) => b.score - a.score)[0];
	feedEvent(s, {
		type: 'match_ended',
		players: s.players.length,
		winningFaction: top && top.score > 0 ? top.name : '',
		factionScores: scores
	});
	feedState(s, POST_MATCH);
}

/** The demo's queued feed events as one batch, or null when there are none. */
export function drainMockFeed(key: string): Record<string, unknown> | null {
	const s = states.get(key);
	if (!s || !s.feed.length) return null;
	const events = s.feed.splice(0);
	return { serverId: `demo-${key}`, serverName: s.serverName, events };
}

function resetScores(s: State): void {
	for (const f of s.factions) {
		f.score = 0;
	}
	s.matchStart = Date.now();
	s.matchId = crypto.randomUUID();
	// Kills, deaths and cash start again, as on the game's scoreboard.
	for (const p of s.players) {
		p.kills = 0;
		p.deaths = 0;
		p.cash = 0;
	}
	feedState(s, PRE_MATCH);
}

function applyEntry(s: State, e: Entry): void {
	s.current = {
		map: e.map,
		experiences: [...e.experiences],
		lighting: e.lighting,
		alternator: e.zoneAlternator || ''
	};
}

function nextPlayable(s: State, from: number): number {
	const n = s.rotation.entries.length;
	for (let step = 1; step <= n; step++) {
		const i = (from + step) % n;
		if (!s.rotation.entries[i].denied) {
			return i;
		}
	}
	return from;
}

function matchOver(s: State): void {
	feedResult(s);
	const r = s.rotation;
	if (r.enabled && r.entries.length) {
		const now = r.nextIndex >= 0 ? r.nextIndex : nextPlayable(s, r.nowIndex);
		if (r.entries[now]) {
			r.nowIndex = now;
			r.nextIndex = nextPlayable(s, now);
			applyEntry(s, r.entries[now]);
		}
	}
	resetScores(s);
}

function log(s: State, event: string, detail: string): void {
	s.audit.push({ timestampUtc: utc(), peer: 'warcon', sessionId: 'warcon01', event, detail });
	if (s.audit.length > 500) {
		s.audit.splice(0, s.audit.length - 500);
	}
}

const ok = (body: unknown, status = 200, extra: Record<string, string> = {}): GameResponse => ({
	status,
	statusText: status === 200 ? 'OK' : '',
	// Live build CL-501228 exposes these two to browsers; the ETag rides on the config document.
	headers: {
		'content-type': 'application/json',
		'access-control-expose-headers': 'ETag, Retry-After',
		...extra
	},
	text: JSON.stringify(body)
});

/** MOCK_RATE_LIMIT_EVERY=N answers every Nth request 429 with Retry-After: 2, to exercise the hold. */
const rateLimitEvery = () => Number(process.env.MOCK_RATE_LIMIT_EVERY) || 0;
let requests = 0;
const fail = (status: number, message: string, code = 'error'): GameResponse =>
	ok({ ok: false, error: { code, message } }, status);

// Update 0.1.2 (live build CL-507060, seen 2026-09-30) refuses a whisper or broadcast longer than
// this, with the answer below; 256 characters are delivered.
const LIVE_CHAT_LIMIT = 256;
const chatTooLong = (text: string): GameResponse | null =>
	liveBuild() && text.length > LIVE_CHAT_LIMIT
		? fail(
				400,
				`Error: message is ${text.length} characters; the limit is ${LIVE_CHAT_LIMIT}.`,
				'message_too_long'
			)
		: null;

function parseBody(body?: string): any {
	if (!body) {
		return {};
	}
	try {
		return JSON.parse(body);
	} catch {
		return {};
	}
}

function entryOut(e: Entry, i: number, s: State) {
	return {
		map: e.map,
		experiences: e.experiences,
		lighting: e.lighting,
		zoneAlternator: e.zoneAlternator || undefined,
		denied: e.denied,
		status: i === s.rotation.nowIndex ? 'now' : i === s.rotation.nextIndex ? 'next' : ''
	};
}

export function mockHandle(
	key: string,
	method: string,
	rawPath: string,
	headers: Record<string, string>,
	body?: string
): GameResponse {
	const auth = headers['authorization'] || headers['Authorization'] || '';
	if (auth !== `Bearer ${MOCK_PASSWORD}`) {
		return fail(401, "Bad RCON password (the demo server's password is 'demo').", 'unauthorized');
	}
	const every = rateLimitEvery();
	if (every > 0 && ++requests % every === 0) {
		return ok(
			{
				ok: false,
				error: { code: 'rate_limited', message: 'Too many requests from this address.' }
			},
			429,
			{ 'retry-after': '2' }
		);
	}
	if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES)
		return fail(413, 'Request body too large.', 'payload_too_large');
	const s = stateFor(key);
	const [path, query = ''] = rawPath.split('?');
	const qs = new URLSearchParams(query);
	const seg = path.split('/').filter(Boolean); // ["v1", ...]
	const b = parseBody(body);
	const m = method.toUpperCase();
	const p = seg.slice(1);
	const route = `${m} ${p.join('/')}`;
	tick(s);

	if (liveBuild()) {
		const pattern = `${m} /v1/${p
			.map((seg, i) =>
				i > 0 && /^\d{17}$/.test(seg) ? '{steamId}' : i > 0 && /^\d+$/.test(seg) ? '{index}' : seg
			)
			.join('/')}`;
		if (LIVE_BUILD_MISSING.has(pattern)) return fail(404, 'No such endpoint.', 'not_found');
	}
	if (route === 'GET capabilities') {
		// The document live build CL-501228 sends (2026-09-14), with the demo's own build string.
		return ok({
			apiVersion: '1',
			build: liveBuild() ? '++Wardogs+Live-CL-501228' : '++Wardogs+Demo-CL-501228',
			auth: { scheme: 'bearer', header: 'Authorization' },
			limits: { maxBodyBytes: MAX_BODY_BYTES, maxRequestsPerMinutePerIp: 600 },
			config: { writable: true, document: '/v1/config' },
			routes: servedRoutes()
		});
	}
	if (route === 'GET health') {
		return ok({
			status: 'ok',
			uptimeSeconds: Math.floor((Date.now() - s.startedAt) / 1000),
			connections: { active: 1 },
			gameThreadQueue: { inFlight: 0, depth: 32, rejectedTotal: 0 }
		});
	}
	if (route === 'GET feed') {
		return ok(
			s.feedReport ?? { enabled: false, endpointCount: 0, anyUnhealthy: false, endpoints: [] }
		);
	}
	if (route === 'GET server-id') {
		// Stable per demo server, standing in for the join code the WARDOGS backend issues.
		return ok({ serverId: demoServerId(key) });
	}
	if (route === 'GET status') {
		return ok({
			serverName: s.serverName,
			map: s.current.map,
			experiences: s.current.experiences,
			lighting: s.current.lighting,
			alternator: s.current.alternator,
			scoreTick: { current: s.scoreTick, min: 18, max: 30 },
			// Live builds CL-499480 and CL-501228 send neither the cap nor the match clock.
			...(liveBuild()
				? {}
				: { scoreCap: s.scoreCap, matchSeconds: Math.floor((Date.now() - s.matchStart) / 1000) }),
			// The live server reports MaxPlayers less the slots MaxReservedSlots holds back (98 for 100).
			players: { current: s.players.length, max: publicSlots(s) },
			factionScores: s.factions.map((f) => ({
				name: f.name,
				colorHex: f.colorHex,
				score: Math.floor(f.score)
			})),
			rotation: {
				nowIndex: s.rotation.nowIndex,
				nextIndex: s.rotation.enabled ? s.rotation.nextIndex : null
			}
		});
	}
	if (route === 'GET players') {
		return ok({ players: s.players });
	}
	if (p[0] === 'players' && p[1]) {
		const player = s.players.find((x) => x.steamId === p[1]);
		if (!player) {
			return fail(404, `Player not found: ${p[1]}`, 'player_not_found');
		}
		if (m === 'POST' && p[2] === 'kick') {
			s.players = s.players.filter((x) => x !== player);
			feedPresence(s, 'player_left', player);
			log(s, 'COMMAND', `kick ${p[1]} ${b.reason || ''}`.trim());
			return ok({ message: `Kicked ${player.name}.` });
		}
		if (m === 'POST' && p[2] === 'kill') {
			player.deaths++;
			log(s, 'COMMAND', `kill ${p[1]}`);
			return ok({ message: `Killed ${player.name}.` });
		}
		if (m === 'POST' && p[2] === 'message') {
			if (!b.message) {
				return fail(400, 'message is required.');
			}
			const long = chatTooLong(String(b.message));
			if (long) return long;
			log(s, 'COMMAND', `msg ${p[1]} ${b.message}`);
			return ok({ message: `Message sent to ${player.name}.` });
		}
		if (m === 'PATCH' && !p[2]) {
			const f = s.factions.find((x) => x.name === b.faction);
			if (!f) {
				return fail(400, `Unknown faction '${b.faction}'.`);
			}
			player.faction = f.name;
			log(s, 'COMMAND', `changeteam ${p[1]} ${f.name}`);
			return ok({ message: `Moved ${player.name} to ${f.name}.` });
		}
	}
	if (route === 'GET bans') {
		return ok({ bans: s.bans });
	}
	if (route === 'POST bans') {
		if (!/^\d{17}$/.test(String(b.steamId || ''))) {
			return fail(400, 'steamId must be a 17-digit SteamID64.');
		}
		const player = s.players.find((x) => x.steamId === b.steamId);
		// The live build only bans a connected player.
		if (!player && liveBuild()) return fail(404, `Error: no player matching '${b.steamId}'.`);
		s.players = s.players.filter((x) => x.steamId !== b.steamId);
		if (player) feedPresence(s, 'player_left', player);
		s.bans = s.bans.filter((x) => x.steamId !== b.steamId);
		s.bans.push({
			steamId: b.steamId,
			bannedAtUtc: utc(),
			bannedBy: 'rcon',
			reason: b.reason || null
		});
		log(s, 'COMMAND', `ban ${b.steamId} ${b.reason || ''}`.trim());
		return ok({ message: `Banned ${player ? player.name : b.steamId}.` });
	}
	if (m === 'DELETE' && p[0] === 'bans' && p[1]) {
		const before = s.bans.length;
		s.bans = s.bans.filter((x) => x.steamId !== p[1]);
		if (s.bans.length === before) {
			return fail(404, `Error: SteamId ${p[1]} is not currently banned.`, 'ban_not_found');
		}
		log(s, 'COMMAND', `unban ${p[1]}`);
		return ok({ message: `Unbanned ${p[1]}.` });
	}
	if (route === 'POST broadcast') {
		if (!b.message) {
			return fail(400, 'message is required.');
		}
		const long = chatTooLong(String(b.message));
		if (long) return long;
		log(s, 'COMMAND', `broadcast ${b.message}`);
		return ok({ message: `Announcement sent to ${s.players.length} player(s).` });
	}
	if (route === 'GET catalog/maps') {
		return ok({ maps: MAPS });
	}
	if (route === 'GET catalog/lightings') {
		return ok({ lightings: LIGHTINGS });
	}
	if (route === 'GET catalog/experiences') {
		return ok({ experiences: EXPERIENCES });
	}
	if (m === 'GET' && p[0] === 'catalog' && p[1] === 'maps' && p[2]) {
		if (p[3] === 'experiences') {
			return ok({ experiences: EXPERIENCES_BY_MAP[p[2]] || [] });
		}
		if (p[3] === 'alternators') {
			return ok({ alternators: ALTERNATORS_BY_MAP[p[2]] || [] });
		}
	}
	if (route === 'POST match/map') {
		if (!MAPS.some((x) => x.id === b.map)) {
			return fail(400, `Unknown map '${b.map}'.`);
		}
		applyEntry(s, {
			map: b.map,
			experiences: b.experiences?.length ? b.experiences : s.current.experiences,
			lighting: b.lighting || s.current.lighting,
			zoneAlternator: b.zoneAlternator || '',
			denied: false
		});
		resetScores(s);
		log(
			s,
			'COMMAND',
			`changemap ${b.map} ${(b.experiences || []).join('+')} ${b.lighting || ''}`.trim()
		);
		return ok({ message: `Changing map to ${b.map}...` });
	}
	if (route === 'POST match/end') {
		matchOver(s);
		log(s, 'COMMAND', 'endmatch');
		return ok({ message: `Match ended — travelling to ${s.current.map}.` });
	}
	if (route === 'POST match/restart') {
		resetScores(s);
		log(s, 'COMMAND', 'restartmatch');
		return ok({ message: `Restarting ${s.current.map}.` });
	}
	if (route === 'PUT world/lighting') {
		if (!LIGHTINGS.some((x) => x.id === b.lighting)) {
			return fail(400, `Unknown lighting '${b.lighting}'.`);
		}
		s.current.lighting = b.lighting;
		log(s, 'COMMAND', `weather ${b.lighting}`);
		return ok({ message: `Weather changed to ${b.lighting}.` });
	}
	if (route === 'GET rotation') {
		return ok({
			enabled: s.rotation.enabled,
			mode: s.rotation.mode,
			entries: s.rotation.entries.map((e, i) => entryOut(e, i, s))
		});
	}
	if (route === 'POST rotation/entries') {
		if (!MAPS.some((x) => x.id === b.map)) {
			return fail(400, `Unknown map '${b.map}'.`);
		}
		s.rotation.entries.push({
			map: b.map,
			experiences: b.experiences?.length ? b.experiences : ['KOTH_InfantryOnly'],
			lighting: b.lighting || 'DayClear',
			zoneAlternator: b.zoneAlternator || '',
			denied: false
		});
		if (s.rotation.entries.length === 2) {
			s.rotation.nextIndex = 1;
		}
		log(s, 'COMMAND', `addrotation ${b.map}`);
		return ok({ message: `Added rotation entry ${s.rotation.entries.length - 1} (${b.map}).` });
	}
	if (p[0] === 'rotation' && p[1] === 'entries' && p[2] !== undefined) {
		const i = Number(p[2]);
		const r = s.rotation;
		if (!(i >= 0 && i < r.entries.length)) {
			return fail(400, `Rotation index ${p[2]} out of range.`);
		}
		if (m === 'DELETE') {
			r.entries.splice(i, 1);
			r.nowIndex = Math.min(r.nowIndex, Math.max(0, r.entries.length - 1));
			r.nextIndex = r.entries.length > 1 ? (r.nowIndex + 1) % r.entries.length : r.nowIndex;
			log(s, 'COMMAND', `removerotation ${i}`);
			return ok({ message: `Removed rotation entry ${i}.` });
		}
		if (m === 'POST' && p[3] === 'move') {
			const t = b.direction === 'up' ? i - 1 : i + 1;
			if (t < 0 || t >= r.entries.length) {
				return fail(400, `Cannot move rotation entry ${i} ${b.direction}.`);
			}
			[r.entries[i], r.entries[t]] = [r.entries[t], r.entries[i]];
			const swap = (x: number) => (x === i ? t : x === t ? i : x);
			r.nowIndex = swap(r.nowIndex);
			r.nextIndex = swap(r.nextIndex);
			log(s, 'COMMAND', `moverotation ${i} ${b.direction}`);
			return ok({ message: `Moved rotation entry ${i} ${b.direction}.` });
		}
	}
	if (route === 'POST rotation/save') {
		s.configText = seedConfig(s);
		s.configRevision++;
		log(s, 'COMMAND', 'saverotation');
		return ok({ message: 'Rotation saved.' });
	}
	if (route === 'PATCH settings') {
		const msgs: string[] = [];
		if (b.scoreTick !== undefined) {
			s.scoreTick = Math.min(30, Math.max(18, Number(b.scoreTick) || 24));
			msgs.push(`ScoreTick set to ${s.scoreTick}.`);
			log(s, 'COMMAND', `set scoretick ${s.scoreTick}`);
		}
		if (b.rotationEnabled !== undefined) {
			s.rotation.enabled = !!b.rotationEnabled;
			msgs.push(`Rotation ${s.rotation.enabled ? 'enabled' : 'disabled'}.`);
			log(s, 'COMMAND', `set rotationenabled ${s.rotation.enabled ? 'on' : 'off'}`);
		}
		if (b.rotationMode !== undefined) {
			s.rotation.mode = String(b.rotationMode).toLowerCase() === 'random' ? 'random' : 'ordered';
			msgs.push(`Rotation mode set to ${s.rotation.mode}.`);
			log(s, 'COMMAND', `set rotationmode ${s.rotation.mode}`);
		}
		if (!msgs.length) {
			return fail(400, 'No settings to apply.');
		}
		return ok({ message: msgs.join(' ') });
	}
	if (route === 'GET reserved-slots') {
		return ok({ reservedSlots: s.reserved });
	}
	if (route === 'POST reserved-slots') {
		if (!/^\d{17}$/.test(String(b.steamId || ''))) {
			return fail(400, 'steamId must be a 17-digit SteamID64.');
		}
		if (s.reserved.includes(b.steamId)) {
			return fail(409, `SteamId ${b.steamId} is already reserved.`, 'already_reserved');
		}
		// The list has no length limit: MaxReservedSlots holds player slots back, it does not cap it.
		s.reserved.push(b.steamId);
		// Persisted to the document like the real server, whose revision moves with the file.
		s.configText = reservedIntoText(s.configText, s.reserved);
		s.configRevision++;
		log(s, 'COMMAND', `reserved add ${b.steamId}`);
		return ok({ message: `Reserved slot added for ${b.steamId}.` });
	}
	if (m === 'DELETE' && p[0] === 'reserved-slots' && p[1]) {
		if (!s.reserved.includes(p[1])) {
			return fail(404, `${p[1]} has no reserved slot.`, 'reserved_slot_not_found');
		}
		s.reserved = s.reserved.filter((x) => x !== p[1]);
		s.configText = reservedIntoText(s.configText, s.reserved);
		s.configRevision++;
		log(s, 'COMMAND', `reserved remove ${p[1]}`);
		return ok({ message: `Reserved slot removed for ${p[1]}.` });
	}
	if (route === 'GET sponsor') {
		return ok({ imageUrl: s.sponsorUrl });
	}
	if (route === 'PUT sponsor') {
		// Real listeners no longer have this route; ServerImageURL goes through PUT /v1/config.
		return fail(405, 'PUT is not supported on this endpoint', 'method_not_allowed');
	}
	if (route === 'GET audit') {
		const limit = Math.min(500, Math.max(1, Number(qs.get('limit')) || 50));
		return ok({ entries: s.audit.slice(-limit) });
	}
	if (route === 'GET config') {
		const revision = `demo${String(s.configRevision).padStart(8, '0')}`;
		return ok(
			{ revision, writable: true, text: s.configText, sections: configSections(), warnings: [] },
			200,
			{ etag: `"${revision}"` }
		);
	}
	if (route === 'POST config/validate' || route === 'PUT config') {
		const text = body || '';
		const errors: { line: number; message: string }[] = [];
		text.split(/\r?\n/).forEach((line, i) => {
			const t = line.trim();
			if (!t || t.startsWith(';') || t.startsWith('#') || /^\[.+\]$/.test(t) || t.includes('=')) {
				return;
			}
			errors.push({ line: i + 1, message: 'Expected key=value or [section].' });
		});
		if (errors.length) {
			return ok(
				{
					ok: false,
					error: { code: 'invalid', message: `${errors.length} line(s) could not be parsed.` },
					errors
				},
				400
			);
		}
		const current = `demo${String(s.configRevision).padStart(8, '0')}`;
		const ifMatch = (headers['if-match'] || headers['If-Match'] || '').replace(/"/g, '');
		if (route === 'PUT config' && ifMatch && ifMatch !== current && qs.get('force') !== 'true') {
			return ok(
				{
					ok: false,
					error: {
						code: 'revision_mismatch',
						message: `The config changed since revision ${ifMatch} (now ${current}).`
					},
					revision: current
				},
				412
			);
		}
		const outcomes = configSections()
			.filter((c) => text.includes(`[${c.section}]`))
			.map((c) => ({
				section: c.section,
				state: c.appliesWhen,
				detail: ''
			}));
		if (route === 'PUT config') {
			// The reserved list lives in the document. A document that carries the key replaces the
			// list (how the console and Warcon reserve slots on builds without the live routes); one
			// without it gets the current list written back, so the two never disagree.
			// ...except on the live build, which loads the list at start: the document changes, the
			// running list does not, until a restart (as seen on a real CL-501228 server).
			if (hasReservedKey(text)) {
				const ids = reservedFromText(text).filter((id) => /^\d{17}$/.test(id));
				if (!liveBuild()) s.reserved = ids;
				else if (liveAddsNow())
					s.reserved = [...s.reserved, ...ids.filter((id) => !s.reserved.includes(id))];
				s.configText = text;
			} else s.configText = reservedIntoText(text, s.reserved);
			s.configRevision++;
			// The TLR host pins ServerName with -RCON_FixedServerName; under MOCK_LIVE_BUILD so does the demo.
			const name = /^ServerName=(.*)$/m.exec(text);
			if (name && !liveBuild()) {
				s.serverName = name[1].trim();
			}
			const img = /^ServerImageURL=(.*)$/m.exec(text);
			if (img) {
				s.sponsorUrl = img[1].trim().replace(/^"|"$/g, '');
			}
			// Like the live build: the rotation section is "rebuilt immediately; used from the next
			// map change". The entry now playing keeps its place by identity, or the pointer resets
			// (see MOCK_ROTATION_POINTER for the other ways a build might do it).
			const rot = rotationFromText(text);
			s.rotation.enabled = rot.enabled;
			s.rotation.mode = rot.mode;
			const was = s.rotation.nowIndex;
			const playing = s.rotation.entries[was];
			s.rotation.entries = rot.entries.map((e) => ({
				...e,
				denied: e.experiences.some((id) => !EXPERIENCES.some((x) => x.id === id))
			}));
			const keep = playing
				? s.rotation.entries.findIndex(
						(e) =>
							e.map === playing.map &&
							e.lighting === playing.lighting &&
							(e.zoneAlternator || '') === (playing.zoneAlternator || '') &&
							e.experiences.join('+') === playing.experiences.join('+')
					)
				: -1;
			const pointer = rotationPointer();
			s.rotation.nowIndex =
				pointer === 'top'
					? Math.max(0, s.rotation.entries.length - 1)
					: pointer === 'index'
						? Math.min(Math.max(was, 0), Math.max(0, s.rotation.entries.length - 1))
						: keep >= 0
							? keep
							: 0;
			s.rotation.nextIndex = s.rotation.entries.length
				? (s.rotation.nowIndex + 1) % s.rotation.entries.length
				: -1;
			log(s, 'COMMAND', `config -> demo${String(s.configRevision).padStart(8, '0')}`);
		}
		return ok({
			ok: true,
			revision: `demo${String(s.configRevision).padStart(8, '0')}`,
			outcomes,
			shadowed: [],
			stripped: [],
			errors: [],
			changed: [],
			warnings: [],
			timingsMs: { total: 3.2 }
		});
	}
	// Live builds answer a missing route exactly like this; a missing item has its own code.
	return fail(404, 'No such endpoint.', 'not_found');
}
