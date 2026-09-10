// The whole database, as Drizzle tables. drizzle-kit reads this file to generate migrations
// (bun run db:generate); the app applies them at startup. Keep it free of SvelteKit imports.
import { sql } from 'drizzle-orm';
import {
	bigserial,
	boolean,
	customType,
	index,
	integer,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * jsonb that hands the value to Bun's SQL driver as is. Drizzle's own jsonb() stringifies first
 * and Bun then JSON-encodes that string again, so arrays and objects landed in Postgres as JSON
 * *strings* (jsonb_typeof = 'string'): fine to read back through Drizzle, unusable inside SQL.
 * Migration 0008 repairs rows written that way. Reads still accept the old shape.
 */
const jsonb = customType<{ data: unknown; driverData: unknown }>({
	dataType: () => 'jsonb',
	toDriver: (value) => value,
	fromDriver: (value) => {
		if (typeof value !== 'string') return value;
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
});

// ---- Better Auth (core + username + admin plugins, plus Warcon's mustChangePassword) -------------

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('email_verified').notNull().default(false),
	image: text('image'),
	createdAt: ts('created_at').notNull().defaultNow(),
	updatedAt: ts('updated_at').notNull().defaultNow(),
	// username plugin
	username: text('username').unique(),
	displayUsername: text('display_username'),
	// admin plugin: role is "owner" | "member"; banned doubles as "disabled"
	role: text('role'),
	banned: boolean('banned').default(false),
	banReason: text('ban_reason'),
	banExpires: ts('ban_expires'),
	// warcon
	mustChangePassword: boolean('must_change_password').notNull().default(false),
	/** the member's own SteamID64, so an org can hand its members a reserved slot */
	steamId: text('steam_id').unique(),
	/** the organisation the panel opens on (dashboard, switcher, Servers); null = every org */
	defaultOrgId: text('default_org_id').references(() => organizations.id, { onDelete: 'set null' })
});

export const session = pgTable(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: ts('expires_at').notNull(),
		token: text('token').notNull().unique(),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		impersonatedBy: text('impersonated_by')
	},
	(t) => [index('session_user_id_idx').on(t.userId)]
);

export const account = pgTable(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: ts('access_token_expires_at'),
		refreshTokenExpiresAt: ts('refresh_token_expires_at'),
		scope: text('scope'),
		password: text('password'),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow(),
		issuer: text('issuer').notNull().default('')
	},
	(t) => [
		index('account_user_id_idx').on(t.userId),
		uniqueIndex('account_issuer_account_id_uidx').on(t.issuer, t.accountId)
	]
);

export const verification = pgTable(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: ts('expires_at').notNull(),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [index('verification_identifier_idx').on(t.identifier)]
);

// ---- Warcon ------------------------------------------------------------------------------------

/** A clan / community. Servers belong to exactly one org; people join through invite links. */
export const organizations = pgTable('organizations', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	createdBy: text('created_by'),
	/** site-owner override of MAX_SERVERS_PER_ORG; null = the instance default */
	serverLimit: integer('server_limit'),
	/** set by the site owner: members lose access, nothing can be added or joined until cleared */
	suspendedAt: ts('suspended_at'),
	suspendedReason: text('suspended_reason').notNull().default(''),
	/** members who set a SteamID on their account get a reserved slot on every org server */
	membersReserved: boolean('members_reserved').notNull().default(false),
	createdAt: ts('created_at').notNull().defaultNow(),
	updatedAt: ts('updated_at').notNull().defaultNow()
});

export const orgMembers = pgTable(
	'org_members',
	{
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/** owner: manages the org, its servers, members and invites, admin everywhere in it. member: per-server grants. */
		role: text('role', { enum: ['owner', 'member'] }).notNull(),
		/** the invite link they joined through, if any */
		inviteId: text('invite_id'),
		createdAt: ts('created_at').notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.orgId, t.userId] }), index('org_members_user_idx').on(t.userId)]
);

/** Shareable join links: <ORIGIN>/join/<token>. */
export const orgInvites = pgTable(
	'org_invites',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		token: text('token').notNull().unique(),
		label: text('label').notNull().default(''),
		orgRole: text('org_role', { enum: ['owner', 'member'] })
			.notNull()
			.default('member'),
		/** granted on every server the org has at join time; null = no server access until an owner grants it */
		serverRole: text('server_role', { enum: ['viewer', 'operator', 'admin'] }),
		/** null = unlimited */
		maxUses: integer('max_uses'),
		uses: integer('uses').notNull().default(0),
		/** null = never */
		expiresAt: ts('expires_at'),
		revokedAt: ts('revoked_at'),
		createdBy: text('created_by'),
		createdAt: ts('created_at').notNull().defaultNow()
	},
	(t) => [index('org_invites_org_idx').on(t.orgId)]
);

export const servers = pgTable('servers', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	host: text('host').notNull(),
	port: integer('port').notNull(),
	scheme: text('scheme', { enum: ['http', 'https'] })
		.notNull()
		.default('http'),
	/** AES-GCM, see crypto.ts */
	passwordEnc: text('password_enc').notNull(),
	notes: text('notes').notNull().default(''),
	sortOrder: integer('sort_order').notNull().default(0),
	/** Set when the site owner saved the target: private addresses (same box, LAN) are permitted. */
	allowPrivate: boolean('allow_private').notNull().default(false),
	createdBy: text('created_by'),
	createdAt: ts('created_at').notNull().defaultNow(),
	updatedAt: ts('updated_at').notNull().defaultNow()
});

export const serverGrants = pgTable(
	'server_grants',
	{
		serverId: text('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['viewer', 'operator', 'admin'] }).notNull(),
		grantedBy: text('granted_by'),
		createdAt: ts('created_at').notNull().defaultNow()
	},
	(t) => [
		primaryKey({ columns: [t.serverId, t.userId] }),
		index('server_grants_user_idx').on(t.userId)
	]
);

export const auditLog = pgTable(
	'audit_log',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		ts: ts('ts').notNull().defaultNow(),
		actorId: text('actor_id'),
		actorName: text('actor_name').notNull().default(''),
		serverId: text('server_id'),
		serverName: text('server_name').notNull().default(''),
		/** the organisation an event belongs to; org owners see these rows, not just their own */
		orgId: text('org_id'),
		/** auth | user | org | server | rcon | system */
		category: text('category').notNull(),
		/** e.g. login, rcon.kick, config.apply */
		action: text('action').notNull(),
		target: text('target').notNull().default(''),
		/** secrets redacted before insert */
		detail: jsonb('detail'),
		outcome: text('outcome', { enum: ['ok', 'error', 'denied'] }).notNull(),
		status: integer('status'),
		message: text('message').notNull().default(''),
		ip: text('ip').notNull().default(''),
		userAgent: text('user_agent').notNull().default(''),
		durationMs: integer('duration_ms')
	},
	(t) => [
		index('audit_ts_idx').on(t.ts),
		index('audit_server_idx').on(t.serverId, t.id),
		index('audit_org_idx').on(t.orgId, t.id),
		index('audit_actor_idx').on(t.actorId, t.id),
		index('audit_action_idx').on(t.category, t.action)
	]
);

export const loginAttempts = pgTable('login_attempts', {
	/** 'u:<username>' or 'ip:<address>' */
	key: text('key').primaryKey(),
	count: integer('count').notNull().default(0),
	firstAt: ts('first_at').notNull(),
	lockedUntil: ts('locked_until')
});

// ---- Analytics (written by the poller; samples becomes a TimescaleDB hypertable) ---------------

export const samples = pgTable(
	'samples',
	{
		ts: ts('ts')
			.notNull()
			.default(sql`now()`),
		serverId: text('server_id').notNull(),
		ok: boolean('ok').notNull(),
		playerCount: integer('player_count'),
		maxPlayers: integer('max_players'),
		map: text('map'),
		/** "a+b" */
		experiences: text('experiences'),
		lighting: text('lighting'),
		matchSeconds: integer('match_seconds'),
		/** [{ name, score }] */
		scores: jsonb('scores'),
		/** [{ name, cash }]: cash held per faction ('' = unassigned), summed over connected players */
		cash: jsonb('cash'),
		latencyMs: integer('latency_ms'),
		error: text('error')
	},
	(t) => [index('samples_server_ts_idx').on(t.serverId, t.ts.desc())]
);

export const playerSessions = pgTable(
	'player_sessions',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		serverId: text('server_id').notNull(),
		steamId: text('steam_id').notNull(),
		name: text('name').notNull(),
		faction: text('faction'),
		joinedAt: ts('joined_at').notNull(),
		lastSeen: ts('last_seen').notNull(),
		/** null while online */
		leftAt: ts('left_at'),
		kills: integer('kills').notNull().default(0),
		deaths: integer('deaths').notNull().default(0),
		cash: integer('cash').notNull().default(0)
	},
	(t) => [
		index('player_sessions_open_idx').on(t.serverId, t.leftAt),
		index('player_sessions_seen_idx').on(t.serverId, t.lastSeen),
		index('player_sessions_steam_idx').on(t.steamId, t.joinedAt)
	]
);

export const matches = pgTable(
	'matches',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		serverId: text('server_id').notNull(),
		/** estimated from matchSeconds at first sight */
		startedAt: ts('started_at').notNull(),
		/** null while in progress */
		endedAt: ts('ended_at'),
		map: text('map'),
		experiences: text('experiences'),
		lighting: text('lighting'),
		peakPlayers: integer('peak_players').notNull().default(0),
		/** [{ name, score }] */
		finalScores: jsonb('final_scores'),
		winner: text('winner')
	},
	(t) => [index('matches_server_idx').on(t.serverId, t.startedAt)]
);

// ---- Player intelligence: org-scoped notes and watchlist, cached Steam data, ban snapshots ------

/** One row per (org, player): the watchlist flag and why. */
export const playerMarks = pgTable(
	'player_marks',
	{
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		steamId: text('steam_id').notNull(),
		watched: boolean('watched').notNull().default(false),
		reason: text('reason').notNull().default(''),
		updatedBy: text('updated_by'),
		updatedByName: text('updated_by_name').notNull().default(''),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.orgId, t.steamId] })]
);

/** Free-text notes admins leave on a player, shared across the org's servers. */
export const playerNotes = pgTable(
	'player_notes',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		steamId: text('steam_id').notNull(),
		authorId: text('author_id'),
		authorName: text('author_name').notNull().default(''),
		body: text('body').notNull(),
		createdAt: ts('created_at').notNull().defaultNow()
	},
	(t) => [index('player_notes_idx').on(t.orgId, t.steamId, t.id)]
);

/** What the Steam Web API last said about a SteamID (persona, account age, VAC and game bans). */
export const steamProfiles = pgTable('steam_profiles', {
	steamId: text('steam_id').primaryKey(),
	persona: text('persona').notNull().default(''),
	avatar: text('avatar').notNull().default(''),
	profileUrl: text('profile_url').notNull().default(''),
	/** community visibility: only public profiles expose the creation date */
	public: boolean('public').notNull().default(false),
	accountCreatedAt: ts('account_created_at'),
	vacBans: integer('vac_bans').notNull().default(0),
	gameBans: integer('game_bans').notNull().default(0),
	daysSinceLastBan: integer('days_since_last_ban'),
	communityBanned: boolean('community_banned').notNull().default(false),
	economyBan: text('economy_ban').notNull().default('none'),
	fetchedAt: ts('fetched_at').notNull().defaultNow(),
	error: text('error').notNull().default('')
});

/** The poller's copy of each game server's ban list, so bans on one server are visible from another. */
export const serverBans = pgTable(
	'server_bans',
	{
		serverId: text('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		steamId: text('steam_id').notNull(),
		reason: text('reason').notNull().default(''),
		bannedBy: text('banned_by').notNull().default(''),
		bannedAtUtc: text('banned_at_utc').notNull().default(''),
		seenAt: ts('seen_at').notNull().defaultNow()
	},
	(t) => [
		primaryKey({ columns: [t.serverId, t.steamId] }),
		index('server_bans_steam_idx').on(t.steamId)
	]
);

// ---- Automation: per-server triggers run by the poller ----------------------------------------

export const triggers = pgTable(
	'triggers',
	{
		id: text('id').primaryKey(),
		serverId: text('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		orgId: text('org_id').notNull(),
		kind: text('kind', { enum: ['welcome', 'broadcast', 'empty_reset', 'risk_kick'] }).notNull(),
		name: text('name').notNull(),
		enabled: boolean('enabled').notNull().default(false),
		/** kind-specific settings, validated in triggers.ts */
		config: jsonb('config').notNull(),
		/** kind-specific runtime state (e.g. the next broadcast index) */
		state: jsonb('state'),
		lastFiredAt: ts('last_fired_at'),
		lastResult: text('last_result').notNull().default(''),
		fireCount: integer('fire_count').notNull().default(0),
		createdBy: text('created_by'),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [index('triggers_server_idx').on(t.serverId)]
);

// ---- Outbound: Discord webhooks that mirror the audit trail -----------------------------------

export const webhooks = pgTable(
	'webhooks',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		label: text('label').notNull().default(''),
		/** the webhook URL is a bearer credential; AES-GCM like RCON passwords */
		urlEnc: text('url_enc').notNull(),
		/** what the UI shows instead of the URL: host and webhook id */
		urlHint: text('url_hint').notNull().default(''),
		/** event classes to mirror; see webhook-delivery.ts */
		events: jsonb('events').notNull(),
		/** null = every server in the org */
		serverIds: jsonb('server_ids'),
		enabled: boolean('enabled').notNull().default(true),
		lastSentAt: ts('last_sent_at'),
		lastStatus: integer('last_status'),
		lastError: text('last_error').notNull().default(''),
		createdBy: text('created_by'),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [index('webhooks_org_idx').on(t.orgId)]
);

// ---- Organisation lists: bans and reserved slots kept in the panel and pushed to every server --

/** A ban list or reserved-slot list an org owns. Servers subscribe through server_lists. */
export const lists = pgTable(
	'lists',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['ban', 'reserve'] }).notNull(),
		name: text('name').notNull().default('Default'),
		/** reserved for sharing between orgs; unused for now */
		shareToken: text('share_token').unique(),
		createdBy: text('created_by'),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [uniqueIndex('lists_org_kind_name_uidx').on(t.orgId, t.kind, t.name)]
);

/** One player on a list. Removal is soft so history and audit stay intact; re-adding inserts a new row. */
export const listEntries = pgTable(
	'list_entries',
	{
		id: text('id').primaryKey(),
		listId: text('list_id')
			.notNull()
			.references(() => lists.id, { onDelete: 'cascade' }),
		steamId: text('steam_id').notNull(),
		reason: text('reason').notNull().default(''),
		/** bans only: lifted automatically after this */
		expiresAt: ts('expires_at'),
		/** reserved slots only: higher wins when a server's MaxReservedSlots is hit */
		priority: integer('priority').notNull().default(0),
		addedBy: text('added_by'),
		addedByName: text('added_by_name').notNull().default(''),
		addedAt: ts('added_at').notNull().defaultNow(),
		removedAt: ts('removed_at'),
		removedBy: text('removed_by'),
		removedByName: text('removed_by_name').notNull().default(''),
		removal: text('removal', { enum: ['manual', 'expired'] })
	},
	(t) => [
		uniqueIndex('list_entries_active_uidx')
			.on(t.listId, t.steamId)
			.where(sql`${t.removedAt} is null`),
		index('list_entries_list_idx').on(t.listId, t.removedAt),
		index('list_entries_steam_idx').on(t.steamId)
	]
);

/** Which lists apply to which server (every org list to every org server, today). */
export const serverLists = pgTable(
	'server_lists',
	{
		serverId: text('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		listId: text('list_id')
			.notNull()
			.references(() => lists.id, { onDelete: 'cascade' })
	},
	(t) => [
		primaryKey({ columns: [t.serverId, t.listId] }),
		index('server_lists_list_idx').on(t.listId)
	]
);

/** The poller's copy of each game server's reserved slots; sibling of server_bans. */
export const serverReserved = pgTable(
	'server_reserved',
	{
		serverId: text('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		steamId: text('steam_id').notNull(),
		seenAt: ts('seen_at').notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.serverId, t.steamId] })]
);

/**
 * What Warcon itself put on a server, and from which list. Entries on the server with no row here
 * are "local" (added outside the panel) and are never removed by the sync.
 */
export const serverListState = pgTable(
	'server_list_state',
	{
		serverId: text('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['ban', 'reserve'] }).notNull(),
		steamId: text('steam_id').notNull(),
		sourceListId: text('source_list_id').references(() => lists.id, { onDelete: 'set null' }),
		state: text('state', { enum: ['applied', 'failed'] }).notNull(),
		error: text('error').notNull().default(''),
		attemptedAt: ts('attempted_at'),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [
		primaryKey({ columns: [t.serverId, t.kind, t.steamId] }),
		index('server_list_state_source_idx').on(t.sourceListId)
	]
);

/** Per-server sync bookkeeping: last run, the reserved-slot cap the server reported, last error. */
export const serverListSync = pgTable('server_list_sync', {
	serverId: text('server_id')
		.primaryKey()
		.references(() => servers.id, { onDelete: 'cascade' }),
	syncedAt: ts('synced_at'),
	reservedCap: integer('reserved_cap'),
	reservedUsed: integer('reserved_used').notNull().default(0),
	capCheckedAt: ts('cap_checked_at'),
	lastError: text('last_error').notNull().default(''),
	updatedAt: ts('updated_at').notNull().defaultNow()
});

// ---- live observation, trigger outbox, settings, worker ownership --------------------------------

/**
 * What the worker last saw on each server: one row per server, overwritten on every observation
 * that changed something (and on a heartbeat), so a page load is one indexed read.
 */
export const serverLive = pgTable('server_live', {
	serverId: text('server_id')
		.primaryKey()
		.references(() => servers.id, { onDelete: 'cascade' }),
	ok: boolean('ok').notNull().default(false),
	error: text('error').notNull().default(''),
	/** watched | hot | idle | offline */
	tier: text('tier').notNull().default('idle'),
	/** Status as the action registry shapes it */
	status: jsonb('status'),
	/** Player[] as the action registry shapes it */
	players: jsonb('players'),
	playerCount: integer('player_count').notNull().default(0),
	statusAt: ts('status_at'),
	playersAt: ts('players_at'),
	/** last attempt, successful or not */
	observedAt: ts('observed_at'),
	updatedAt: ts('updated_at').notNull().defaultNow()
});

/**
 * Trigger actions the rules decided on, written in the same transaction as the observation that
 * caused them and delivered by the worker afterwards. A crash between the two leaves the row, not
 * a lost whisper. `unknown` is a send with no answer; it is never retried automatically.
 */
export const outbox = pgTable(
	'outbox',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		serverId: text('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		triggerId: text('trigger_id'),
		triggerName: text('trigger_name').notNull().default(''),
		triggerKind: text('trigger_kind').notNull().default(''),
		/** an action name from the registry, or "sequence" with params.steps */
		action: text('action').notNull(),
		params: jsonb('params'),
		/** SteamID or message the audit row names */
		target: text('target').notNull().default(''),
		/** extra fields for the audit row */
		detail: jsonb('detail'),
		/** a whisper or kick is only meaningful while the player is on; null for broadcasts */
		steamId: text('steam_id'),
		okMessage: text('ok_message').notNull().default(''),
		dedupeKey: text('dedupe_key').notNull(),
		/** pending | delivered | failed | unknown | skipped */
		state: text('state').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		notBefore: ts('not_before').notNull().defaultNow(),
		leaseUntil: ts('lease_until'),
		outcome: text('outcome').notNull().default(''),
		createdAt: ts('created_at').notNull().defaultNow(),
		doneAt: ts('done_at')
	},
	(t) => [
		uniqueIndex('outbox_dedupe_idx').on(t.dedupeKey),
		index('outbox_pending_idx').on(t.state, t.notBefore),
		index('outbox_server_idx').on(t.serverId, t.createdAt.desc())
	]
);

/**
 * Hourly rollups of samples (rollups.ts fills them; analytics.ts reads them for ranges longer than
 * the raw retention). Durations are seconds of cover; player_s is player-count × seconds while up.
 */
export const sampleRollups = pgTable(
	'sample_rollups',
	{
		serverId: text('server_id').notNull(),
		bucket: ts('bucket').notNull(),
		samples: integer('samples').notNull().default(0),
		okSamples: integer('ok_samples').notNull().default(0),
		upS: real('up_s').notNull().default(0),
		downS: real('down_s').notNull().default(0),
		playerS: real('player_s').notNull().default(0),
		maxPlayers: integer('max_players'),
		maxCap: integer('max_cap')
	},
	(t) => [primaryKey({ columns: [t.serverId, t.bucket] })]
);

export const sampleMapRollups = pgTable(
	'sample_map_rollups',
	{
		serverId: text('server_id').notNull(),
		bucket: ts('bucket').notNull(),
		map: text('map').notNull(),
		secs: real('secs').notNull().default(0)
	},
	(t) => [primaryKey({ columns: [t.serverId, t.bucket, t.map] })]
);

/** Owner-editable runtime settings (cadences, budgets, retention); see settings.ts for keys and bounds. */
export const siteSettings = pgTable('site_settings', {
	key: text('key').primaryKey(),
	value: jsonb('value'),
	updatedAt: ts('updated_at').notNull().defaultNow(),
	updatedBy: text('updated_by')
});

/**
 * One row: which worker process owns observation and delivery, with a lease it must keep
 * renewing. Every worker write checks the token inside its transaction (fencing), so a worker
 * that lost the lease can never write late.
 */
export const workerOwnership = pgTable('worker_ownership', {
	id: integer('id').primaryKey(),
	token: text('token').notNull(),
	label: text('label').notNull().default(''),
	acquiredAt: ts('acquired_at').notNull().defaultNow(),
	leaseUntil: ts('lease_until').notNull()
});

export type ServerRow = typeof servers.$inferSelect;
export type OrgRow = typeof organizations.$inferSelect;
export type OrgInviteRow = typeof orgInvites.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type SampleRow = typeof samples.$inferSelect;
export type SteamProfileRow = typeof steamProfiles.$inferSelect;
export type TriggerRow = typeof triggers.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type PlayerNoteRow = typeof playerNotes.$inferSelect;
export type PlayerMarkRow = typeof playerMarks.$inferSelect;
export type ListRow = typeof lists.$inferSelect;
export type ListEntryRow = typeof listEntries.$inferSelect;
export type ServerListStateRow = typeof serverListState.$inferSelect;
export type ServerListSyncRow = typeof serverListSync.$inferSelect;
export type ServerLiveRow = typeof serverLive.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
