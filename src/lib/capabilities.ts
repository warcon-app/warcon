// The permission vocabulary. A capability is one thing a person (or an API key) may do on a
// server; an organisation's roles are named sets of them, and org owners and the site owner hold
// every one. This module is pure and client-safe: pages, the role editor and the server all read
// the same list, so the browser can hide a button for exactly the reason the API refuses it.
import type { ListKind } from './types';

export const CAPABILITIES = [
	'server.view',
	'chat.read',
	'chat.send',
	'players.kick',
	'players.kill',
	'players.move',
	'match.control',
	'rotation.edit',
	'players.notes',
	'rotation.save',
	'players.notes.manage',
	'bans.manage',
	'slots.manage',
	'lists.ban',
	'lists.reserve',
	'config.apply',
	'automation.manage',
	'audit.read',
	'rcon.raw'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Every role must be able to see the server it is a role on; nothing else is mandatory. */
export const VIEW: Capability = 'server.view';

export type CapabilityGroup = 'read' | 'play' | 'moderate' | 'manage';

export const CAPABILITY_GROUPS: { key: CapabilityGroup; label: string; hint: string }[] = [
	{ key: 'read', label: 'Read', hint: 'See the server without touching it.' },
	{ key: 'play', label: 'Play', hint: 'Day-to-day running of a match.' },
	{ key: 'moderate', label: 'Moderate', hint: 'Bans, reserved slots and the org lists.' },
	{ key: 'manage', label: 'Manage', hint: 'Settings, automation and raw access.' }
];

export interface CapabilityInfo {
	label: string;
	/** what it unlocks, in the words the panel uses */
	hint: string;
	group: CapabilityGroup;
}

export const CAPABILITY_INFO: Record<Capability, CapabilityInfo> = {
	'server.view': {
		label: 'View',
		hint: 'What is happening on the server: status, players, kills, rotation, who is banned and who holds a reserved slot, analytics, leaderboards and player stats.',
		group: 'read'
	},
	'chat.read': {
		label: 'Read chat',
		hint: "Read the in-game chat as players type it, to moderate the server, once an owner has accepted the game's chat terms; and save the rules that answer what players type. Nothing of it is kept.",
		group: 'read'
	},
	'chat.send': {
		label: 'Chat',
		hint: 'Broadcast to everyone; whisper a player, several, or a faction.',
		group: 'play'
	},
	'players.kick': { label: 'Kick', hint: 'Kick a player off the server.', group: 'play' },
	'players.kill': { label: 'Kill', hint: "Kill a player's character.", group: 'play' },
	'players.move': {
		label: 'Move',
		hint: 'Move a player to another team; they are killed so they respawn on it.',
		group: 'play'
	},
	'match.control': {
		label: 'Match control',
		hint: 'End or restart the match, change map, set the next map, set weather.',
		group: 'play'
	},
	'rotation.edit': {
		label: 'Live rotation',
		hint: 'Add, remove and reorder rotation entries on the running server.',
		group: 'play'
	},
	'players.notes': {
		label: 'Notes & watchlist',
		hint: 'Read and add player notes, delete your own, watch or unwatch players and see why they are watched.',
		group: 'play'
	},
	'bans.manage': { label: 'Bans', hint: 'Ban and unban on this server.', group: 'moderate' },
	'slots.manage': {
		label: 'Reserved slots',
		hint: 'Reserve and unreserve slots on this server (through its config document on builds without the live routes), and read the note on each.',
		group: 'moderate'
	},
	'lists.ban': {
		label: 'Org ban list',
		hint: "Ban and unban on every server through the organisation's ban list, and push the lists to servers; see a player's entry on it in the dossier.",
		group: 'moderate'
	},
	'lists.reserve': {
		label: 'Org reserved slots',
		hint: "Reserve and withdraw slots on every server through the organisation's reserved-slot list, and push the lists to servers; see a player's entry on it in the dossier.",
		group: 'moderate'
	},
	'players.notes.manage': {
		label: "Others' notes",
		hint: 'Delete notes written by anyone.',
		group: 'moderate'
	},
	'rotation.save': {
		label: 'Save rotation',
		hint: 'Persist the rotation, switch rotation mode on or off.',
		group: 'manage'
	},
	'config.apply': {
		label: 'Config & settings',
		hint: 'Read, validate and apply the config document; score tick, sponsor image, connection test.',
		group: 'manage'
	},
	'automation.manage': {
		label: 'Automation',
		hint: 'See the triggers and what they did; create, edit, dry-run and delete them.',
		group: 'manage'
	},
	'audit.read': {
		label: 'Audit trail',
		hint: "See everyone's actions on this server in the audit log, not just your own, and the game server's own RCON log.",
		group: 'manage'
	},
	'rcon.raw': {
		label: 'Raw RCON',
		hint: 'Call any /v1 route on the game server directly, except the config document and the chat.',
		group: 'manage'
	}
};

/**
 * Each of the organisation's lists has a capability of its own: holding it on any server of the
 * org opens that list, which then applies on every server of it.
 */
export const LIST_CAPABILITY: Record<ListKind, Capability> = {
	ban: 'lists.ban',
	reserve: 'lists.reserve'
};

/** The org lists a set of capabilities may edit, ban list first. */
export const listKindsIn = (caps: Iterable<string>): ListKind[] => {
	const held = new Set(caps);
	return (['ban', 'reserve'] as const).filter((k) => held.has(LIST_CAPABILITY[k]));
};

/** Capabilities in display order, grouped for the role editor. */
export const capabilitiesByGroup = (): {
	group: (typeof CAPABILITY_GROUPS)[number];
	caps: Capability[];
}[] =>
	CAPABILITY_GROUPS.map((group) => ({
		group,
		caps: CAPABILITIES.filter((c) => CAPABILITY_INFO[c].group === group.key)
	}));

// ---- built-in roles ----------------------------------------------------------------------------

export const BUILTIN_ROLES = ['viewer', 'operator', 'admin'] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

const OPERATOR: Capability[] = [
	'server.view',
	'chat.send',
	'players.kick',
	'players.kill',
	'players.move',
	'match.control',
	'rotation.edit',
	'players.notes'
];

/**
 * Capabilities an API key never holds, whatever its row says. Players' chat is shown to the people
 * who moderate a server, under the game's chat terms (it is not to be recorded, stored or
 * exported), so it is not handed to a program. Nor does a key save a rule that has the panel read
 * the chat (a Chat command, a Staff call): saving one needs this capability (server/triggers.ts).
 */
export const PEOPLE_ONLY: readonly Capability[] = ['chat.read'];

/**
 * What each built-in role starts with; owners may change them per organisation. Reading chat is
 * in none of them, the admin role included: an organisation's owners decide who reads what its
 * players type.
 */
export const BUILTIN_CAPABILITIES: Record<BuiltinRole, Capability[]> = {
	viewer: ['server.view'],
	operator: OPERATOR,
	admin: CAPABILITIES.filter((c) => c !== 'chat.read')
};

export const isBuiltinRole = (v: unknown): v is BuiltinRole =>
	typeof v === 'string' && (BUILTIN_ROLES as readonly string[]).includes(v);

// ---- helpers ------------------------------------------------------------------------------------

export const isCapability = (v: unknown): v is Capability =>
	typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);

/**
 * Turns a request body or a stored jsonb value into a clean capability list: unknown strings are
 * an error (a typo must not silently grant nothing), duplicates collapse, order is canonical.
 */
export function parseCapabilities(raw: unknown): Capability[] {
	if (!Array.isArray(raw)) throw new Error('capabilities must be a list.');
	const seen = new Set<Capability>();
	for (const v of raw) {
		if (!isCapability(v)) throw new Error(`Unknown capability: ${String(v).slice(0, 40)}`);
		seen.add(v);
	}
	return CAPABILITIES.filter((c) => seen.has(c));
}

/** Stored values are trusted but may predate a rename; keep only what is still known. */
export const knownCapabilities = (raw: unknown): Capability[] =>
	Array.isArray(raw) ? CAPABILITIES.filter((c) => raw.includes(c)) : [];

export const can = (caps: Iterable<string> | null | undefined, cap: Capability): boolean => {
	if (!caps) return false;
	if (caps instanceof Set) return caps.has(cap);
	for (const c of caps) if (c === cap) return true;
	return false;
};

/** "View · Chat · Bans" for tables and tooltips. */
export const capabilitySummary = (caps: Iterable<string> | null | undefined): string =>
	knownCapabilities([...(caps ?? [])])
		.map((c) => CAPABILITY_INFO[c].label)
		.join(' · ');
