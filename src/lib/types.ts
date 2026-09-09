// Shapes shared by pages, API routes and the action registry.
import type { OrgRole, ServerRole } from '$lib/server/access';

export type { OrgRole, ServerRole };

export interface ServerInfo {
	id: string;
	orgId: string;
	orgName: string;
	name: string;
	host: string;
	port: number;
	scheme: 'http' | 'https';
	notes: string;
	role: ServerRole;
	/** true when the role comes from owning the org: may edit, delete and share the server */
	manager: boolean;
	sortOrder: number;
	demo: boolean;
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
export interface Features {
	changeTeam: boolean;
	configDocument: boolean;
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
export interface ConfigDoc {
	revision: string;
	writable: boolean;
	text: string;
	sections: unknown[];
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
	image: string | null;
	createdAt: string | null;
	lastLoginAt: string | null;
	grants: { serverId: string; serverName: string; role: ServerRole }[];
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
	grants: { serverId: string; serverName: string; role: ServerRole }[];
}

/** live: usable now; revoked / expired / used (up): why it is not. */
export type InviteStatus = 'live' | 'revoked' | 'expired' | 'used';

export interface InviteView {
	id: string;
	label: string;
	orgRole: OrgRole;
	serverRole: ServerRole | null;
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
	kills: number;
	deaths: number;
	cash: number;
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
	/** the player's standing on the organisation's lists, and whether the viewer may change it */
	orgLists: { ban: ListEntryView | null; reserve: ListEntryView | null; canEdit: boolean };
	summary: {
		sessions: number;
		minutes: number;
		kills: number;
		deaths: number;
		firstSeen: string | null;
		lastSeen: string | null;
	};
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

export type TriggerKind = 'welcome' | 'broadcast' | 'empty_reset' | 'risk_kick';

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
	priority: number;
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
	membersReserved: boolean;
	servers: {
		id: string;
		name: string;
		/** last successful sync run; null = never */
		syncedAt: string | null;
		/** MaxReservedSlots as last read from the server; null = unknown */
		reservedCap: number | null;
		reservedUsed: number;
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

/** Per-server view of which bans and reserved slots the org lists manage; for the players page. */
export interface ServerListsState {
	canEditOrg: boolean;
	/** owners may import (adopt) local entries into the org list */
	orgOwner: boolean;
	orgId: string;
	bans: Record<string, { state: ListEntryState; managed: boolean }>;
	reserved: Record<string, { state: ListEntryState; managed: boolean }>;
	sync: {
		syncedAt: string | null;
		reservedCap: number | null;
		reservedUsed: number;
		lastError: string;
	} | null;
}
