// Shapes shared by pages, API routes and the action registry.
import type { StatusStyle } from './status-styles';
import type { OrgRole } from '$lib/server/access';
import type { BuiltinRole, Capability } from '$lib/capabilities';

export type { OrgRole, Capability, BuiltinRole };

/** A server role of one organisation: a name and what it may do. */
export interface RoleView {
	id: string;
	name: string;
	capabilities: Capability[];
	/** which shipped role it started as; null for roles the org added */
	builtin: BuiltinRole | null;
	sortOrder: number;
	/** what points at it right now: deletion is refused while either is non-zero */
	inUse: { grants: number; invites: number };
	createdAt: string | null;
	updatedAt: string | null;
}

/** A bearer credential owned by an organisation; the token itself is only ever returned on creation. */
export interface ApiKeyView {
	id: string;
	label: string;
	/** the token's prefix and first characters, for telling keys apart */
	hint: string;
	capabilities: Capability[];
	/** null = every server in the org, including ones added later */
	serverIds: string[] | null;
	createdBy: { username: string; name: string } | null;
	createdAt: string | null;
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
}

/** One person's role on one server, as grant lists show it. */
export interface GrantRef {
	serverId: string;
	serverName: string;
	roleId: string;
	roleName: string;
}

export interface ServerInfo {
	id: string;
	orgId: string;
	orgName: string;
	name: string;
	host: string;
	port: number;
	scheme: 'http' | 'https';
	notes: string;
	/** the granted role's name; 'owner' when access comes from running the org */
	roleName: string;
	caps: Capability[];
	/** true when access comes from owning the org: may edit, delete and share the server */
	manager: boolean;
	sortOrder: number;
	demo: boolean;
	/** the org owner's switches for the public pages; see $lib/features for what is actually on */
	publicStatus: boolean;
	publicLeaderboards: boolean;
	publicMatches: boolean;
	/** the public status page also carries the last kills */
	publicKills: boolean;
	/** what the site owner allows this server's organisation */
	allowPublicStatus: boolean;
	allowPublicLeaderboards: boolean;
	allowPublicMatches: boolean;
}

export interface CatalogItem {
	id: string;
	display: string;
}
export interface Catalog {
	maps: CatalogItem[];
	lightings: CatalogItem[];
	experiences: CatalogItem[];
}
/** What a server's build serves. Live build CL-499480 (2026-09-11) lacks the last four. */
export interface Features {
	changeTeam: boolean;
	configDocument: boolean;
	/** POST/DELETE /v1/reserved-slots */
	reservedSlots: boolean;
	/** POST /v1/rotation/entries and .../move: add, remove, move, set next map */
	rotationEdit: boolean;
	/** POST /v1/rotation/save */
	rotationSave: boolean;
	/** PATCH /v1/settings: score tick, rotation enabled and mode */
	liveSettings: boolean;
	/** GET /v1/server-id: the join code the WARDOGS backend issued the server (CL-501228+) */
	serverId: boolean;
}

export interface FactionScore {
	name: string;
	colorHex: string;
	score: number;
}
export interface Status {
	serverName: string;
	map: string;
	experiences: string[];
	lighting: string;
	alternator: string;
	scoreTick: number | null;
	scoreTickMin: number | null;
	scoreTickMax: number | null;
	scoreCap: number | null;
	matchSeconds: number | null;
	playerCount: number;
	maxPlayers: number;
	scores: FactionScore[];
	rotationNow: number;
	rotationNext: number;
	/** the status document as the server sent it; only on a connection test */
	raw?: Record<string, unknown>;
}
export interface Player {
	name: string;
	steamId: string;
	faction: string | null;
	kills: number;
	deaths: number;
	cash: number;
	ping: number | null;
}
/** What the worker last saw on a server: the dashboard, server page and players page render this. */
export interface LiveView {
	serverId: string;
	ok: boolean;
	error: string;
	tier: 'watched' | 'hot' | 'idle' | 'offline';
	/** the build string from GET /v1/capabilities; '' until the worker has read it */
	build: string;
	/** the join code from GET /v1/server-id (CL-501228+); '' when unknown or unserved */
	gameServerId: string;
	/** when the game process started (from GET /v1/health); null until read, or unserved by the build */
	startedAt: string | null;
	/**
	 * MaxReservedSlots from the config document: player slots held back from public joins for
	 * reserved players, on top of `status.maxPlayers`; null until the worker has read it
	 */
	reservedSlots: number | null;
	/** set while the listener has asked the panel to slow down (429 with Retry-After) */
	throttledUntil: string | null;
	status: Status | null;
	players: Player[];
	statusAt: string | null;
	playersAt: string | null;
	observedAt: string | null;
}
/** One kill as the game's feed reported it and Warcon stored it (kills table). */
export interface KillView {
	eventId: string;
	/** when Warcon received it */
	ts: string;
	map: string;
	/** seconds on the match clock */
	eventTime: number;
	/** null: the environment */
	killer: { steamId: string; name: string; faction: string | null } | null;
	victim: { steamId: string; name: string; faction: string | null };
	/** the raw weapon or vehicle tag; $lib/causes labels it */
	cause: string | null;
	distanceM: number | null;
	headshot: boolean;
	suicide: boolean;
	teamKill: boolean;
	tags: string[];
}
/** One trigger action and what became of it. */
export interface OutboxView {
	id: number;
	triggerId: string | null;
	triggerName: string;
	triggerKind: string;
	action: string;
	target: string;
	state: 'pending' | 'sending' | 'delivered' | 'failed' | 'skipped' | 'unknown';
	attempts: number;
	outcome: string;
	createdAt: string;
	doneAt: string | null;
}
export interface RotationEntry {
	map: string;
	experiences: string[];
	lighting: string;
	zoneAlternator: string;
	denied: boolean;
	status: string;
}
export interface Rotation {
	enabled: boolean;
	mode: string;
	nowIndex: number;
	nextIndex: number;
	entries: RotationEntry[];
}
export interface MapSelection {
	map: string;
	experiences: string[];
	lighting: string;
	zoneAlternator: string;
}
export interface Ban {
	steamId: string;
	bannedAtUtc: string;
	bannedBy: string;
	reason: string;
}
/** How the server says one config section (or one key in it) takes effect when applied. */
export interface ConfigSection {
	section: string;
	appliesWhen: string;
	description?: string;
	/** the keys the server's allow-list keeps for this section; anything else is stripped on apply */
	allowedKeys?: string[];
	keyOverrides?: {
		key: string;
		appliesWhen: string;
		description?: string;
		/** false when a launch argument pins the key (live build CL-501228+): shown, not editable */
		writable?: boolean;
		/** the launch argument that pins it, e.g. RCON_FixedServerName or RCONPort */
		lockedBy?: string;
	}[];
}
export interface ConfigDoc {
	revision: string;
	writable: boolean;
	text: string;
	sections: ConfigSection[];
	warnings: unknown[];
}
export interface ConfigResult {
	ok: boolean;
	status: number;
	conflict: boolean;
	revision: string;
	errorCode: string;
	errorMessage: string;
	outcomes: { section: string; state: string; detail?: string }[];
	shadowed: { section: string; key: string; declared: string; effective: string }[];
	stripped: unknown[];
	errors: { line?: number; message?: string }[];
	changed: unknown[];
	conflictDeltas: unknown[];
	warnings: unknown[];
	timingsMs: { total?: number } | null;
}
export interface LogEntry {
	timestampUtc: string;
	peer: string;
	sessionId: string;
	event: string;
	detail: string;
}

export interface UserView {
	id: string;
	username: string;
	name: string;
	role: 'owner' | 'member';
	disabled: boolean;
	mustChangePassword: boolean;
	/** meets the sign-in rules (two ways in, second factor on any password, ...) */
	authComplete: boolean;
	/** sign-in methods on file, e.g. ["password", "authenticator", "passkey ×2", "discord"] */
	signIn: string[];
	image: string | null;
	createdAt: string | null;
	lastLoginAt: string | null;
	grants: GrantRef[];
	orgs: { orgId: string; orgName: string; role: OrgRole }[];
}

export interface OrgView {
	id: string;
	name: string;
	slug: string;
	memberCount: number;
	serverCount: number;
	/** servers the org may hold right now (its own override, else the instance default) */
	serverLimit: number;
	/** the site owner's per-org override, if any */
	customServerLimit: number | null;
	suspended: { at: string; reason: string } | null;
	/** site-owner allowances for the public surfaces ($lib/features) */
	allowPublicStatus: boolean;
	allowPublicLeaderboards: boolean;
	allowPublicMatches: boolean;
	/** the org's Discord invite link for its public pages; '' = none */
	discordInviteUrl: string;
	createdBy: { username: string; name: string } | null;
	createdAt: string | null;
}

export interface OrgMemberView {
	userId: string;
	username: string;
	name: string;
	image: string | null;
	siteOwner: boolean;
	disabled: boolean;
	role: OrgRole;
	joinedAt: string | null;
	grants: GrantRef[];
}

/** live: usable now; revoked / expired / used (up): why it is not. */
export type InviteStatus = 'live' | 'revoked' | 'expired' | 'used';

export interface InviteView {
	id: string;
	label: string;
	orgRole: OrgRole;
	/** the role granted on every current server at join time; null = none */
	serverRoleId: string | null;
	serverRoleName: string | null;
	maxUses: number | null;
	uses: number;
	expiresAt: string | null;
	revokedAt: string | null;
	createdAt: string | null;
	url: string;
	status: InviteStatus;
	/** the status as a sentence for people, or null while it is live */
	problem: string | null;
}

// ---- player intelligence ------------------------------------------------------------------------

export interface SteamView {
	persona: string;
	avatar: string;
	profileUrl: string;
	public: boolean;
	accountCreatedAt: string | null;
	accountAgeDays: number | null;
	vacBans: number;
	gameBans: number;
	daysSinceLastBan: number | null;
	communityBanned: boolean;
	economyBan: string;
	friendsState: string;
	friendsTotal: number;
	friendsChecked: number;
	bannedFriends: number;
	fetchedAt: string;
	error: string;
}

export interface RiskView {
	score: number;
	level: 'low' | 'medium' | 'high';
	reasons: { code: string; text: string; weight: number }[];
	steamChecked: boolean;
}

/** What the players table shows next to each connected player. */
export interface PlayerMark {
	steamId: string;
	watched: boolean;
	reason: string;
	firstVisit: boolean;
	risk: RiskView;
}

export interface PlayerNoteView {
	id: number;
	authorId: string | null;
	authorName: string;
	body: string;
	createdAt: string;
	/** the caller may delete it (author, or admin on this server) */
	deletable: boolean;
}

export interface DossierSession {
	id: number;
	serverId: string;
	serverName: string;
	name: string;
	faction: string | null;
	joinedAt: string;
	lastSeen: string;
	leftAt: string | null;
	minutes: number;
	/** minutes of this session with the player count at or under the server's seeding threshold */
	seedMinutes: number;
	kills: number;
	deaths: number;
	cash: number;
}

/** A player's kill-feed record across some servers: what the dossier and a public career show. */
export interface CombatSummary {
	kills: number;
	deaths: number;
	headshots: number;
	teamKills: number;
	/** times this player was team-killed */
	teamKilled: number;
	suicides: number;
	avgDistanceM: number | null;
	longestM: number | null;
	causes: { cause: string; kills: number }[];
	victims: { steamId: string; name: string; kills: number }[];
	nemeses: { steamId: string; name: string; deaths: number }[];
}
export interface PlayerCombat extends CombatSummary {
	/** the last kills and deaths involving the player, newest first */
	recent: (KillView & { serverId: string; serverName: string })[];
}
export interface DossierView {
	steamId: string;
	name: string;
	names: string[];
	online: { serverId: string; serverName: string } | null;
	steamEnabled: boolean;
	steam: SteamView | null;
	risk: RiskView;
	watch: { watched: boolean; reason: string; updatedByName: string; updatedAt: string | null };
	bannedOn: { serverId: string; serverName: string; reason: string; bannedBy: string }[];
	/** how many servers the organisation runs (for "banned on N of M") */
	orgServerCount: number;
	/**
	 * the player's entry on each organisation list the viewer edits (null on the others, whatever
	 * they hold), and which lists those are
	 */
	orgLists: {
		ban: ListEntryView | null;
		reserve: ListEntryView | null;
		canBan: boolean;
		canReserve: boolean;
	};
	summary: {
		sessions: number;
		minutes: number;
		kills: number;
		deaths: number;
		firstSeen: string | null;
		lastSeen: string | null;
	};
	/** from the kill feed, across the org's servers the viewer can see; null when none has one */
	combat: PlayerCombat | null;
	perServer: {
		serverId: string;
		serverName: string;
		sessions: number;
		minutes: number;
		kills: number;
		deaths: number;
		lastSeen: string;
	}[];
	recent: DossierSession[];
	notes: PlayerNoteView[];
	actions: {
		id: number;
		ts: string;
		actorName: string;
		action: string;
		serverName: string;
		outcome: string;
		message: string;
	}[];
}

// ---- automation ---------------------------------------------------------------------------------

export type TriggerKind =
	| 'welcome'
	| 'faction_change'
	| 'broadcast'
	| 'empty_reset'
	| 'risk_kick'
	| 'ping_kick'
	| 'restart_notice'
	| 'team_kill'
	| 'seed_reward'
	| 'match_broadcast'
	| 'name_filter'
	| 'kill_rate';

export interface TriggerView {
	id: string;
	kind: TriggerKind;
	name: string;
	enabled: boolean;
	config: Record<string, unknown>;
	lastFiredAt: string | null;
	lastResult: string;
	fireCount: number;
	createdAt: string | null;
}

export interface DryRunResult {
	kind: TriggerKind;
	from: string;
	to: string;
	fires: number;
	items: { at: string; text: string }[];
	notes: string[];
}

// ---- webhooks -----------------------------------------------------------------------------------

export interface WebhookView {
	id: string;
	label: string;
	urlHint: string;
	events: string[];
	serverIds: string[] | null;
	enabled: boolean;
	/** keeps a live status card per covered server in the channel, edited in place */
	statusEnabled: boolean;
	statusStyle: StatusStyle;
	/** seconds between edits of one card, 30-300 */
	statusIntervalS: number;
	/** which links the card carries (each public one only while that page is on for the server) */
	linkStatus: boolean;
	linkLeaderboard: boolean;
	linkPanel: boolean;
	statusSentAt: string | null;
	lastSentAt: string | null;
	lastStatus: number | null;
	lastError: string;
	createdAt: string | null;
}

// ---- organisation lists (bans and reserved slots pushed to every server) ------------------------

export type ListKind = 'ban' | 'reserve';

export interface ListView {
	id: string;
	kind: ListKind;
	name: string;
	entryCount: number;
}

/**
 * How one entry stands on one server: applied by Warcon, failed to apply, still pending, or
 * present on the server but added outside the panel (local).
 */
export type ListEntryState = 'applied' | 'failed' | 'pending' | 'local';

export interface ListServerStateView {
	serverId: string;
	serverName: string;
	state: ListEntryState;
	error: string;
}

export interface ListEntryView {
	id: string;
	kind: ListKind;
	steamId: string;
	/** last name seen on the org's servers, else the Steam persona, else null */
	name: string | null;
	reason: string;
	expiresAt: string | null;
	/** true once expiresAt has passed and the poller has not yet lifted it */
	expired: boolean;
	addedByName: string;
	addedAt: string;
	removedAt: string | null;
	removedByName: string;
	removal: 'manual' | 'expired' | null;
	/** derived from org membership (members-reserved), not an entry someone added */
	member: boolean;
	servers: ListServerStateView[];
}

export interface ListSyncServer {
	serverId: string;
	serverName: string;
	/** the server was reached and the plan ran */
	ok: boolean;
	added: number;
	removed: number;
	failed: number;
	/** still running in the background when the request returned */
	pending: boolean;
	error: string;
}

export interface ListSyncSummary {
	servers: ListSyncServer[];
}

export interface OrgListsView {
	role: 'owner' | 'editor';
	/** the lists the reader edits; `lists` holds only these */
	kinds: ListKind[];
	membersReserved: boolean;
	/** what a banned player is shown, see $lib/ban-message; null unless the reader edits the ban list */
	banMessage: string | null;
	servers: {
		id: string;
		name: string;
		/** last successful sync run; null = never */
		syncedAt: string | null;
		/** why the last run could not reach or finish on the server */
		lastError: string;
	}[];
	lists: ListView[];
}

export interface ImportCandidate {
	kind: ListKind;
	steamId: string;
	name: string | null;
	servers: { serverId: string; serverName: string; reason: string; bannedBy: string }[];
}

/** One ban as the server's Bans page shows it. */
export interface BanState {
	state: ListEntryState;
	managed: boolean;
	/** the list a managed ban comes from: the organisation's, or this server's own */
	scope: 'org' | 'server';
	/** the reason on the list entry */
	reason: string;
	/** who added the entry; blank unless the reader manages bans here or edits the org's ban list */
	addedByName: string;
	addedAt: string | null;
	/** when the panel lifts the ban; null for a permanent one (or one not managed) */
	expiresAt: string | null;
}

/** One reserved slot as the server's Reserved slots page shows it. */
export interface ReservedSlotState {
	state: ListEntryState;
	managed: boolean;
	/** last name seen on the org's servers, else the Steam persona, else null */
	name: string | null;
	/** the note on the list entry, if any */
	note: string;
	/** a slot the org hands its members, not an entry someone added */
	member: boolean;
	/** the list a managed slot comes from: the organisation's, or this server's own */
	scope: 'org' | 'server';
	/** when the panel lifts the slot; null for a permanent one (or one not managed) */
	expiresAt: string | null;
}

/** Per-server view of which bans and reserved slots the org lists manage; for the players page. */
export interface ServerListsState {
	/** may edit the organisation's ban list ('Org ban list' on a server of the org, or an owner) */
	canEditOrgBans: boolean;
	/** may edit the organisation's reserved-slot list ('Org reserved slots', or an owner) */
	canEditOrgSlots: boolean;
	/** owners may import (adopt) local entries into the org list */
	orgOwner: boolean;
	orgId: string;
	/** the org's ban message, for those who manage bans here or edit the org's ban list; else null */
	banMessage: string | null;
	bans: Record<string, BanState>;
	reserved: Record<string, ReservedSlotState>;
	sync: {
		syncedAt: string | null;
		lastError: string;
	} | null;
}
