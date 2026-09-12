// The permission vocabulary. A capability is one thing a person (or an API key) may do on a
// server; an organisation's roles are named sets of them, and org owners and the site owner hold
// every one. This module is pure and client-safe: pages, the role editor and the server all read
// the same list, so the browser can hide a button for exactly the reason the API refuses it.

export const CAPABILITIES = [
	'server.view',
	'chat.send',
	'players.moderate',
	'match.control',
	'rotation.edit',
	'players.notes',
	'rotation.save',
	'players.notes.manage',
	'bans.manage',
	'slots.manage',
	'lists.edit',
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
		hint: 'Status, players, rotation, bans, reserved slots, config, server log, analytics, player dossiers, triggers.',
		group: 'read'
	},
	'chat.send': {
		label: 'Chat',
		hint: 'Broadcast to everyone; whisper to a player.',
		group: 'play'
	},
	'players.moderate': {
		label: 'Kick, kill, move',
		hint: 'Kick or kill a player; move them to another team.',
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
		hint: 'Add player notes, delete your own, and watch or unwatch players.',
		group: 'play'
	},
	'bans.manage': { label: 'Bans', hint: 'Ban and unban on this server.', group: 'moderate' },
	'slots.manage': {
		label: 'Reserved slots',
		hint: 'Reserve and unreserve slots on this server.',
		group: 'moderate'
	},
	'lists.edit': {
		label: 'Org lists',
		hint: "Edit the organisation's ban and reserved-slot lists and push them to servers.",
		group: 'moderate'
	},
	'players.notes.manage': {
		label: "Others' notes",
		hint: 'Delete notes written by anyone; see the full dossier.',
		group: 'moderate'
	},
	'rotation.save': {
		label: 'Save rotation',
		hint: 'Persist the rotation, switch rotation mode on or off.',
		group: 'manage'
	},
	'config.apply': {
		label: 'Config & settings',
		hint: 'Score tick, sponsor image, validate and apply the config document, connection test.',
		group: 'manage'
	},
	'automation.manage': {
		label: 'Automation',
		hint: 'Create, edit, dry-run and delete triggers.',
		group: 'manage'
	},
	'audit.read': {
		label: 'Audit trail',
		hint: "See everyone's actions on this server in the audit log, not just your own.",
		group: 'manage'
	},
	'rcon.raw': {
		label: 'Raw RCON',
		hint: 'Call any /v1 route on the game server directly.',
		group: 'manage'
	}
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
	'players.moderate',
	'match.control',
	'rotation.edit',
	'players.notes'
];

/** What each built-in role starts with; owners may change them per organisation. */
export const BUILTIN_CAPABILITIES: Record<BuiltinRole, Capability[]> = {
	viewer: ['server.view'],
	operator: OPERATOR,
	admin: [...CAPABILITIES]
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
