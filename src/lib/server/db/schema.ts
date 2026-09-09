// The whole database, as Drizzle tables. drizzle-kit reads this file to generate migrations
// (bun run db:generate); the app applies them at startup. Keep it free of SvelteKit imports.
import { sql } from 'drizzle-orm';
import {
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

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
	mustChangePassword: boolean('must_change_password').notNull().default(false)
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
