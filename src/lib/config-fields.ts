// The ServerSettings.ini keys the form editor manages, mirroring the official console's config
// editor: which section each lives in, its type, default and what applying it means.
import type { ConfigSection } from './types';

export type FieldType = 'text' | 'number' | 'bool' | 'enum' | 'slider';
export type FieldValue = string | number | boolean;
export type ApplyState = 'applied' | 'next-match' | 'next-restart' | 'pending';

export interface ConfigField {
	key: string;
	label: string;
	type: FieldType;
	section: string;
	ini: string;
	def: FieldValue;
	group: string;
	help: string;
	min?: number;
	max?: number;
	unit?: string;
	options?: [string, string][];
	/** two fields drawn side by side as a range (min/max) */
	pair?: string;
	pairLabel?: string;
	/** also changeable at once through PATCH /v1/settings; where the panel offers that */
	live?: string;
	/** what the console assumes when the server does not describe the section itself */
	appliesFallback?: { state: ApplyState; description: string };
}

export const S_SESSION = '/Script/WDGame.WDGameSession';
export const S_PREMATCH = 'MatchState.PreMatch.WaitingForPlayers.PlayerCount';
export const S_KOTH = 'MatchState.Playing.KOTH';
export const S_STATE = '/Script/WDGame.WDGameStateSession';
export const S_ROTATION = '/Script/WDGame.WDServerMapRotationSettings';
export const S_ENGINE = '/Script/Engine.GameSession';

const JOIN_LIMIT_NOTE = {
	state: 'next-restart' as const,
	description:
		'Older server builds do not send join limits on a session update, so on those it takes effect on restart. A current server applies it as soon as Apply returns.'
};

/** The game's own welcome popup (Season 3); its text has an editor of its own under these fields. */
export const WELCOME_GROUP = 'Welcome popup';

export const GROUPS = [
	'Server',
	'Join limits',
	'Slots and start',
	'Scoring',
	'Team balance',
	'Rotation',
	WELCOME_GROUP
];

const WELCOME_NOTE = {
	state: 'next-match' as const,
	description:
		'The game reads the welcome popup when a match starts, so a change shows from the next match.'
};

export const FIELDS: ConfigField[] = [
	{
		key: 'serverName',
		label: 'Server name',
		type: 'text',
		section: S_SESSION,
		ini: 'ServerName',
		def: '',
		group: 'Server',
		help: 'The name shown in the server browser. Applies immediately; the listing refreshes on the server’s next heartbeat.'
	},
	{
		key: 'serverPassword',
		label: 'Join password',
		type: 'text',
		section: S_SESSION,
		ini: 'ServerPassword',
		def: '',
		group: 'Server',
		appliesFallback: {
			state: 'next-restart',
			description:
				'Older server builds only send the join password when a session is created, so on those it takes effect on restart. A current server applies it at once, for new joins.'
		},
		help: 'Password players must enter to join. Empty means an open server.'
	},
	{
		key: 'maxPlayers',
		label: 'Maximum players',
		type: 'number',
		min: 1,
		section: S_ENGINE,
		ini: 'MaxPlayers',
		def: 128,
		group: 'Server',
		appliesFallback: {
			state: 'next-restart',
			description:
				'A slot count is deliberately not changed under a running match, so this takes effect when the server restarts.'
		},
		help: 'Total player slots, reserved slots included. The live server reports this less Maximum reserved slots as its cap: 100 with 2 held back shows as 98. Lowering it does not kick anyone; it stops new joins once the new capacity is in force.'
	},
	{
		key: 'imageUrl',
		label: 'Sponsor image URL',
		type: 'text',
		section: S_SESSION,
		ini: 'ServerImageURL',
		def: '',
		group: 'Server',
		help: 'Server browser banner: a 1024×256 PNG/JPEG on the server’s image allow-list. Only settable through the config document (the Sponsor image panel above applies it the same way). The server fetches and checks it before advertising it, so it reports as pending until that finishes.'
	},
	{
		key: 'minPlayerCash',
		label: 'Minimum player cash',
		type: 'number',
		min: 0,
		pair: 'cash',
		pairLabel: 'Player cash range',
		section: S_SESSION,
		ini: 'ServerMinPlayerCash',
		def: 0,
		group: 'Join limits',
		appliesFallback: JOIN_LIMIT_NOTE,
		help: 'Players below this cash cannot join. 0 = no restriction.'
	},
	{
		key: 'maxPlayerCash',
		label: 'Maximum player cash',
		type: 'number',
		min: 0,
		pair: 'cash',
		section: S_SESSION,
		ini: 'ServerMaxPlayerCash',
		def: 0,
		group: 'Join limits',
		appliesFallback: JOIN_LIMIT_NOTE,
		help: 'Players above this cash cannot join. 0 = no restriction.'
	},
	{
		key: 'minPlayerLevel',
		label: 'Minimum player level',
		type: 'number',
		min: 0,
		pair: 'level',
		pairLabel: 'Player level range',
		section: S_SESSION,
		ini: 'ServerMinPlayerLevel',
		def: 0,
		group: 'Join limits',
		appliesFallback: JOIN_LIMIT_NOTE,
		help: 'Players below this level cannot join. 0 = no restriction.'
	},
	{
		key: 'maxPlayerLevel',
		label: 'Maximum player level',
		type: 'number',
		min: 0,
		pair: 'level',
		section: S_SESSION,
		ini: 'ServerMaxPlayerLevel',
		def: 0,
		group: 'Join limits',
		appliesFallback: JOIN_LIMIT_NOTE,
		help: 'Players above this level cannot join. 0 = no restriction.'
	},
	{
		key: 'maxReservedSlots',
		label: 'Maximum reserved slots',
		type: 'number',
		min: 0,
		section: S_SESSION,
		ini: 'MaxReservedSlots',
		def: 20,
		group: 'Slots and start',
		help: 'How many of the player slots are held back from public joins for players on the reserved list. It does not limit the list: anyone on it skips the join queue however long it is, even with 0 here.'
	},
	{
		key: 'minRequiredPlayers',
		label: 'Pre-match minimum players',
		type: 'number',
		min: 0,
		section: S_PREMATCH,
		ini: 'MinimumRequiredPlayers',
		def: 60,
		group: 'Slots and start',
		help: 'Players required before pre-match becomes a live match. The loaded experience sets its own floor and the higher of the two wins, so a value below that floor changes nothing.'
	},
	{
		key: 'scorePeriod',
		label: 'Score tick',
		type: 'slider',
		min: 18,
		max: 30,
		unit: 's',
		section: S_KOTH,
		ini: 'ScorePeriod',
		def: 24,
		group: 'Scoring',
		live: 'the Score tick slider above',
		appliesFallback: {
			state: 'next-match',
			description:
				'Scoring cadence never changes during a round; the match in progress keeps its current value and the new one is used from the next match.'
		},
		help: 'Seconds between score ticks. A faster tick fires more often and pays less each time, on a banded multiplier. The server refuses values outside its allowed range.'
	},
	{
		key: 'lockOverpopulated',
		label: 'Lock overpopulated teams',
		type: 'bool',
		section: S_STATE,
		ini: 'bLockOverpopulatedTeamsConfig',
		def: true,
		group: 'Team balance',
		help: 'Stop players joining a team that already leads by the threshold below.'
	},
	{
		key: 'overpopThreshold',
		label: 'Population threshold',
		type: 'number',
		min: 0,
		section: S_STATE,
		ini: 'OverpopulatedTeamThresholdConfig',
		def: 2,
		group: 'Team balance',
		help: 'How many players ahead a team must be before it locks.'
	},
	{
		key: 'rotationEnabled',
		label: 'Map rotation',
		type: 'bool',
		section: S_ROTATION,
		ini: 'bEnabled',
		def: true,
		group: 'Rotation',
		live: 'the Map rotation tab',
		help: 'Advance through the rotation entries after each match.'
	},
	{
		key: 'rotationMode',
		label: 'Rotation mode',
		type: 'enum',
		options: [
			['Ordered', 'Ordered'],
			['Random', 'Random']
		],
		section: S_ROTATION,
		ini: 'RotationMode',
		def: 'Ordered',
		group: 'Rotation',
		live: 'the Map rotation tab',
		help: 'Ordered walks the rotation top to bottom; Random picks each next entry.'
	},
	{
		key: 'welcomeEnabled',
		label: 'Show the popup',
		type: 'bool',
		section: S_STATE,
		ini: 'bServerWelcomeMessageEnabled',
		def: false,
		group: WELCOME_GROUP,
		appliesFallback: WELCOME_NOTE,
		help: 'Shows each player the text below in a popup, once, when they first deploy.'
	},
	{
		key: 'welcomeCloseDelay',
		label: 'Close countdown',
		type: 'number',
		min: 0,
		max: 60,
		unit: 's',
		section: S_STATE,
		ini: 'ServerWelcomeMessageCloseDelaySeconds',
		def: 0,
		group: WELCOME_GROUP,
		appliesFallback: WELCOME_NOTE,
		help: 'Seconds the popup’s Close button stays locked, so players read it first. 0 = no lock.'
	},
	{
		key: 'welcomeSkipStreamers',
		label: 'Skip for streamers',
		type: 'bool',
		section: S_STATE,
		ini: 'bServerWelcomeMessageSkipForStreamers',
		def: false,
		group: WELCOME_GROUP,
		appliesFallback: WELCOME_NOTE,
		help: 'Players with streamer mode on do not get the popup.'
	}
];

/**
 * The popup's text, ServerWelcomeMessageLines: a list of lines, so not among FIELDS, whose values
 * are one line of the file each. Here for what a field says of its key: when a change applies,
 * and whether the command line pins it.
 */
export const WELCOME_TEXT: ConfigField = {
	key: 'welcomeLines',
	label: 'Text',
	type: 'text',
	section: S_STATE,
	ini: 'ServerWelcomeMessageLines',
	def: '',
	group: WELCOME_GROUP,
	appliesFallback: WELCOME_NOTE,
	help: ''
};

export const isNumeric = (f: ConfigField) => f.type === 'number' || f.type === 'slider';

/** The ini text as a typed value; undefined when the key is absent or unreadable. */
export function fromIniValue(f: ConfigField, raw: string | null): FieldValue | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (f.type === 'bool') return /^(true|1|yes|on)$/i.test(raw.trim());
	if (isNumeric(f)) {
		const n = Number(raw.trim());
		return Number.isFinite(n) ? n : undefined;
	}
	return raw;
}

export function toIniValue(f: ConfigField, v: FieldValue | undefined): string {
	if (f.type === 'bool') return v ? 'True' : 'False';
	if (isNumeric(f)) return String(Number(v) || 0);
	return v === undefined || v === null ? '' : String(v);
}

export const APPLY_BADGES: Record<ApplyState, { label: string; cls: string }> = {
	applied: { label: 'live update', cls: 'bg-ok/15 text-ok' },
	'next-match': { label: 'next match', cls: 'bg-info/15 text-info' },
	'next-restart': { label: 'server restart', cls: 'bg-warn/15 text-warn' },
	pending: { label: 'checked on apply', cls: 'bg-white/10 text-mist-400' }
};

/**
 * When a change to this field takes effect, from the server's own description of its config
 * sections (a key override first, then the section), else the console's fallback.
 */
export function appliesFor(
	f: ConfigField,
	sections: ConfigSection[]
): { state: ApplyState; description: string } | null {
	const section = sections.find((s) => s.section === f.section);
	if (!section) return f.appliesFallback ?? null;
	if (!Array.isArray(section.keyOverrides)) {
		return (
			f.appliesFallback ?? {
				state: section.appliesWhen as ApplyState,
				description: section.description || ''
			}
		);
	}
	const override = section.keyOverrides.find(
		(k) => String(k.key).toLowerCase() === f.ini.toLowerCase()
	);
	const src = override || section;
	return { state: src.appliesWhen as ApplyState, description: src.description || '' };
}

export interface LockedKey {
	section: string;
	key: string;
	/** the launch argument that pins it, e.g. RCON_FixedServerName; '' when the server did not say */
	lockedBy: string;
	description: string;
}

const PINNED =
	"Pinned on this server's command line. The value is shown but cannot be changed here.";

const overrideFor = (section: ConfigSection, ini: string) =>
	Array.isArray(section.keyOverrides)
		? section.keyOverrides.find((k) => String(k.key).toLowerCase() === ini.toLowerCase())
		: undefined;

/**
 * The override that pins this field from the command line (`writable: false`, live build
 * CL-501228+: ServerName under -RCON_FixedServerName), or null when it can be edited.
 */
export function lockedFor(f: ConfigField, sections: ConfigSection[]): LockedKey | null {
	const section = sections.find((s) => s.section === f.section);
	const o = section ? overrideFor(section, f.ini) : undefined;
	if (!o || o.writable !== false) return null;
	return {
		section: f.section,
		key: o.key,
		lockedBy: o.lockedBy || '',
		description: o.description || PINNED
	};
}

/** Every key the server reports as pinned, whether or not the form has a field for it (Port has none). */
export function lockedKeys(sections: ConfigSection[]): LockedKey[] {
	const out: LockedKey[] = [];
	for (const s of sections)
		for (const o of s.keyOverrides ?? [])
			if (o.writable === false)
				out.push({
					section: s.section,
					key: o.key,
					lockedBy: o.lockedBy || '',
					description: o.description || PINNED
				});
	return out;
}
