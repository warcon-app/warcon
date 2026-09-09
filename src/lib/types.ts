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
