// An in-process imitation of the WARDOGS dedicated server's WDRCON HTTP API.
// Used when a server is added with host "demo" (and ALLOW_DEMO_SERVER is on) so the whole
// panel can be exercised without a game server. State lives in process memory and resets
// on restart, which is fine for a demo.
//
// Route shapes mirror what rcon.wardogs.com's js/api.js expects from a real server.

import type { GameResponse } from './transport';
import { parseMaxReservedSlots } from './lists-plan';
import { rotationFromText } from '../rotation-doc';

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
	'DayEndClear'
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

// Routes live build CL-499480 (2026-09-11) does not serve. With MOCK_LIVE_BUILD=true the demo
// servers drop them too, so that build's behaviour can be exercised without a real server.
const LIVE_BUILD_MISSING = new Set([
	'POST /v1/reserved-slots',
	'DELETE /v1/reserved-slots/{steamId}',
	'POST /v1/rotation/entries',
	'DELETE /v1/rotation/entries/{index}',
	'POST /v1/rotation/entries/{index}/move',
	'POST /v1/rotation/save',
	'PATCH /v1/settings'
]);
const liveBuild = () => /^(1|true|yes)$/i.test(process.env.MOCK_LIVE_BUILD || '');
const servedRoutes = () =>
	liveBuild() ? CAPABILITY_ROUTES.filter((r) => !LIVE_BUILD_MISSING.has(r)) : CAPABILITY_ROUTES;

const CAPABILITY_ROUTES = [
	'GET /v1/capabilities',
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
	'PUT /v1/config'
];

// The schema live build CL-499480 reports from GET /v1/config (captured 2026-09-11).
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
		allowedKeys: ['AllowedOrigins', 'bEnabled', 'BindAddress', 'Password', 'PasswordHash', 'Port'],
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
			mk('Rooikat', '76561198100000111', 'Manticore', 7, 3, 2900, 73)
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
		configRevision: 1
	};
	state.configText = seedConfig(state);
	return state;
}

function seedConfig(s: State): string {
	return [
		'[/Script/WDGame.WDGameSession]',
		`ServerName=${s.serverName}`,
		'ServerPassword=',
		`ServerImageURL=${s.sponsorUrl}`,
		'MaxReservedSlots=20',
		...s.reserved.map((id) => `+DefaultReservedPlayerIds="${id}"`),
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
		''
	].join('\r\n');
}

const states = new Map<string, State>();

function stateFor(key: string): State {
	let s = states.get(key);
	if (!s) {
		s = seed(`Warcon Demo Server [${key.slice(0, 6)}]`);
		states.set(key, s);
	}
	return s;
}

function tick(s: State): void {
	const now = Date.now();
	const dt = (now - s.lastScoreAt) / 1000;
	s.lastScoreAt = now;
	for (const f of s.factions) {
		f.score += f.rate * dt * (0.8 + Math.random() * 0.4);
	}
	if (s.factions.some((f) => f.score >= s.scoreCap)) {
		matchOver(s);
	}
	for (const p of s.players) {
		if (Math.random() < 0.05) {
			p.kills++;
			p.cash += 150;
			const v = s.players[Math.floor(Math.random() * s.players.length)];
			if (v !== p) {
				v.deaths++;
			}
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
		}
	}
	// Someone new drifts in now and then; quicker while the server is quiet, so joins (and the
	// triggers that watch for them) are easy to see on the demo.
	if (s.players.length < 16 && Math.random() < (s.players.length < 12 ? 0.2 : 0.04)) {
		s.players.push({
			name: JOINERS[s.nextJoiner % JOINERS.length],
			steamId: String(76561198100000401n + BigInt(s.nextJoiner++)),
			faction: s.factions[Math.floor(Math.random() * s.factions.length)].name,
			kills: 0,
			deaths: 0,
			cash: 0,
			pingMs: 20 + Math.floor(Math.random() * 90)
		});
	}
}

function resetScores(s: State): void {
	for (const f of s.factions) {
		f.score = 0;
	}
	s.matchStart = Date.now();
	for (const p of s.players) {
		p.kills = 0;
		p.deaths = 0;
		p.cash = 0;
	}
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

const ok = (body: unknown, status = 200): GameResponse => ({
	status,
	statusText: status === 200 ? 'OK' : '',
	headers: { 'content-type': 'application/json' },
	text: JSON.stringify(body)
});
const fail = (status: number, message: string, code = 'error'): GameResponse =>
	ok({ ok: false, error: { code, message } }, status);

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
		return ok({ routes: servedRoutes(), config: { writable: true } });
	}
	if (route === 'GET status') {
		return ok({
			serverName: s.serverName,
			map: s.current.map,
			experiences: s.current.experiences,
			lighting: s.current.lighting,
			alternator: s.current.alternator,
			scoreTick: { current: s.scoreTick, min: 18, max: 30 },
			scoreCap: s.scoreCap,
			matchSeconds: Math.floor((Date.now() - s.matchStart) / 1000),
			players: { current: s.players.length, max: s.maxPlayers },
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
		s.players = s.players.filter((x) => x.steamId !== b.steamId);
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
		if (!s.reserved.includes(b.steamId)) {
			// MaxReservedSlots from the config document is honoured, like the real server.
			const cap = parseMaxReservedSlots(s.configText) ?? 20;
			if (s.reserved.length >= cap) {
				return fail(409, `Reserved slots are full (${cap}/${cap}).`, 'reserved_full');
			}
			s.reserved.push(b.steamId);
		}
		log(s, 'COMMAND', `reserved add ${b.steamId}`);
		return ok({ message: `Reserved slot added for ${b.steamId}.` });
	}
	if (m === 'DELETE' && p[0] === 'reserved-slots' && p[1]) {
		if (!s.reserved.includes(p[1])) {
			return fail(404, `${p[1]} has no reserved slot.`, 'reserved_slot_not_found');
		}
		s.reserved = s.reserved.filter((x) => x !== p[1]);
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
		return ok({
			revision: `demo${String(s.configRevision).padStart(8, '0')}`,
			writable: true,
			text: s.configText,
			sections: CONFIG_SECTIONS,
			warnings: []
		});
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
		const outcomes = CONFIG_SECTIONS.filter((c) => text.includes(`[${c.section}]`)).map((c) => ({
			section: c.section,
			state: c.appliesWhen,
			detail: ''
		}));
		if (route === 'PUT config') {
			s.configText = text;
			s.configRevision++;
			const name = /^ServerName=(.*)$/m.exec(text);
			if (name) {
				s.serverName = name[1].trim();
			}
			const img = /^ServerImageURL=(.*)$/m.exec(text);
			if (img) {
				s.sponsorUrl = img[1].trim().replace(/^"|"$/g, '');
			}
			// Like the live build: the rotation section is "rebuilt immediately; used from the next
			// map change". The entry now playing keeps its place by identity, or the pointer resets.
			const rot = rotationFromText(text);
			s.rotation.enabled = rot.enabled;
			s.rotation.mode = rot.mode;
			const playing = s.rotation.entries[s.rotation.nowIndex];
			s.rotation.entries = rot.entries.map((e) => ({
				...e,
				denied: e.experiences.some((id) => !EXPERIENCES.some((x) => x.id === id))
			}));
			const keep = playing
				? s.rotation.entries.findIndex(
						(e) =>
							e.map === playing.map &&
							e.lighting === playing.lighting &&
							e.experiences.join('+') === playing.experiences.join('+')
					)
				: -1;
			s.rotation.nowIndex = keep >= 0 ? keep : 0;
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
