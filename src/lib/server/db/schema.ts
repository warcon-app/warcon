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

export type ServerRow = typeof servers.$inferSelect;
export type OrgRow = typeof organizations.$inferSelect;
export type OrgInviteRow = typeof orgInvites.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type SampleRow = typeof samples.$inferSelect;
