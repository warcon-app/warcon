// The whole database, as Drizzle tables. drizzle-kit reads this file to generate migrations
// (bun run db:generate); the app applies them at startup. Keep it free of SvelteKit imports.
import { sql } from 'drizzle-orm';
import {
	bigint,
	bigserial,
	boolean,
	check,
	customType,
	date,
	index,
	integer,
	numeric,
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
	defaultOrgId: text('default_org_id').references(() => organizations.id, { onDelete: 'set null' }),
	// two-factor plugin
	twoFactorEnabled: boolean('two_factor_enabled').default(false),
	// warcon sign-in policy (see enrolment.ts): recomputed whenever a sign-in method changes
	/** the account meets the sign-in rules (two ways in, a second factor on the password, ...) */
	authComplete: boolean('auth_complete').notNull().default(false),
	/** first sign-in since the rules arrived; the grace period counts from here */
	authGraceStartedAt: ts('auth_grace_started_at'),
	/** sha-256 of the one-time recovery key; null = none issued (or the last one was used) */
	recoveryKeyHash: text('recovery_key_hash'),
	recoveryKeyAt: ts('recovery_key_at')
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

/** two-factor plugin: one TOTP secret and the (encrypted) backup codes per user */
export const twoFactor = pgTable(
	'two_factor',
	{
		id: text('id').primaryKey(),
		secret: text('secret').notNull(),
		backupCodes: text('backup_codes').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/** false between "enable" and the first code the user proves they can produce */
		verified: boolean('verified').default(true),
		failedVerificationCount: integer('failed_verification_count').default(0),
		lockedUntil: ts('locked_until')
	},
	(t) => [index('two_factor_user_id_idx').on(t.userId), index('two_factor_secret_idx').on(t.secret)]
);

/** passkey plugin: WebAuthn credentials; a user may hold several (phone, laptop, security key) */
export const passkey = pgTable(
	'passkey',
	{
		id: text('id').primaryKey(),
		name: text('name'),
		publicKey: text('public_key').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		credentialID: text('credential_id').notNull(),
		counter: integer('counter').notNull(),
		deviceType: text('device_type').notNull(),
		backedUp: boolean('backed_up').notNull(),
		transports: text('transports'),
		createdAt: ts('created_at'),
		aaguid: text('aaguid')
	},
	(t) => [
		index('passkey_user_id_idx').on(t.userId),
		index('passkey_credential_id_idx').on(t.credentialID)
	]
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
	/**
	 * Site-owner allowances: what this org's owners may switch on per server, allowed unless the
	 * site owner withdraws it. Each public surface needs the allowance and the server's own
	 * switch; $lib/features computes the effective set.
	 */
	allowPublicStatus: boolean('allow_public_status').notNull().default(true),
	allowPublicLeaderboards: boolean('allow_public_leaderboards').notNull().default(true),
	/** a discord.gg or discord.com/invite link, shown as a button on the org's public pages; '' = none */
	discordInviteUrl: text('discord_invite_url').notNull().default(''),
	/** what a banned player is shown: the reason and facts about the ban, see $lib/ban-message */
	banMessage: text('ban_message').notNull().default('{reason}'),
	/** what the org's boards open on: official | custom | 30d | all ($lib/seasons, BOARD_OPENS) */
	boardOpens: text('board_opens').notNull().default('official'),
	/** the columns its public boards leave out ($lib/leaderboard, BOARD_COLUMNS); none = every one */
	boardHidden: text('board_hidden')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	createdAt: ts('created_at').notNull().defaultNow(),
	updatedAt: ts('updated_at').notNull().defaultNow()
});

/**
 * A community's own season: a name and a start, running until its next season starts
 * ($lib/seasons). Nothing is stored per player: its board is a range over the kept history. Once
 * one has started its start stays put, so a finished season's standings never move.
 */
export const seasons = pgTable(
	'seasons',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		startsAt: ts('starts_at').notNull(),
		createdBy: text('created_by'),
		createdAt: ts('created_at').notNull().defaultNow()
	},
	(t) => [uniqueIndex('seasons_org_start_uidx').on(t.orgId, t.startsAt)]
);

/**
 * The org's quick reasons: the buttons under Reason in the ban dialog ($lib/ban-reasons). No row
 * means the built-in six. Kept off `organizations`, whose whole row the worker reads with every
 * server every few seconds.
 */
export const orgBanReasons = pgTable('org_ban_reasons', {
	orgId: text('org_id')
		.primaryKey()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	/** BanReason[], in the order the buttons show */
	reasons: jsonb('reasons').notNull(),
	updatedAt: ts('updated_at').notNull().defaultNow()
});

/**
 * An org's server roles: a name and the capabilities it carries (see $lib/capabilities). Every org
 * starts with the three built-ins, which owners may edit but not delete; custom roles are more rows.
 */
export const orgRoles = pgTable(
	'org_roles',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		/** Capability[] */
		capabilities: jsonb('capabilities').notNull(),
		/** which built-in this row started as; null for custom roles. Built-ins can be reset. */
		builtin: text('builtin', { enum: ['viewer', 'operator', 'admin'] }),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('org_roles_builtin_uidx')
			.on(t.orgId, t.builtin)
			.where(sql`${t.builtin} is not null`),
		uniqueIndex('org_roles_name_uidx').on(t.orgId, sql`lower(${t.name})`)
	]
);

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
		serverRoleId: text('server_role_id').references(() => orgRoles.id, { onDelete: 'set null' }),
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

/**
 * Bearer credentials for bots and scripts, owned by an organisation. A key carries its own
 * capability set and an optional server allowlist (null = every org server, present and future);
 * it can never manage the org. Only the SHA-256 of the token is stored; the token is shown once.
 */
export const apiKeys = pgTable(
	'api_keys',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		label: text('label').notNull(),
		keyHash: text('key_hash').notNull().unique(),
		/** what the UI shows instead of the token: the prefix and the first few characters */
		hint: text('hint').notNull(),
		/** Capability[] */
		capabilities: jsonb('capabilities').notNull(),
		/** null = every server in the org */
		serverIds: jsonb('server_ids'),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: ts('created_at').notNull().defaultNow(),
		lastUsedAt: ts('last_used_at'),
		expiresAt: ts('expires_at'),
		revokedAt: ts('revoked_at')
	},
	(t) => [index('api_keys_org_idx').on(t.orgId)]
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
	/**
	 * The kill feed token the game sends as its bearer (`[WDServerFeed] Token`), AES-GCM like the
	 * password so it can be shown again and written into the config document; null = no feed.
	 */
	feedTokenEnc: text('feed_token_enc'),
	/** sha256 of the token: how a feed batch finds its server */
	feedTokenHash: text('feed_token_hash').unique(),
	/** the org owner's switches for the public pages; effective only with the org's allowance ($lib/features) */
	publicStatus: boolean('public_status').notNull().default(false),
	publicLeaderboards: boolean('public_leaderboards').notNull().default(false),
	/** the public status page also shows the last kills (needs the feed and the status page on) */
	publicKills: boolean('public_kills').notNull().default(false),
	/**
	 * An owner's own restart time, `{ time: 'HH:MM' }` (UTC, $lib/uptime's ManualRestart), used
	 * instead of the game's: null = the game decides (RestartTimeUtc, else 24 hours up).
	 */
	restartSchedule: jsonb('restart_schedule'),
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
		/** must belong to the server's org; the writers in orgs.ts / users.ts / servers.ts check this */
		roleId: text('role_id')
			.notNull()
			.references(() => orgRoles.id, { onDelete: 'restrict' }),
		grantedBy: text('granted_by'),
		createdAt: ts('created_at').notNull().defaultNow()
	},
	(t) => [
		primaryKey({ columns: [t.serverId, t.userId] }),
		index('server_grants_user_idx').on(t.userId),
		index('server_grants_role_idx').on(t.roleId)
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
		userAgent: text('user_agent').notNull().default(''),
		durationMs: integer('duration_ms')
	},
	(t) => [
		index('audit_ts_idx').on(t.ts),
		index('audit_server_idx').on(t.serverId, t.id),
		index('audit_org_idx').on(t.orgId, t.id),
		index('audit_actor_idx').on(t.actorId, t.id),
		index('audit_action_idx').on(t.category, t.action),
		/** a player's history on the dossier (target is their SteamID); rows without a target stay out */
		index('audit_target_idx')
			.on(t.target, t.id)
			.where(sql`${t.target} <> ''`)
	]
);

export const loginAttempts = pgTable('login_attempts', {
	/** 'u:<username>', or 'ip:' / 'signup:' + a keyed hash of the address (addressKey in http.ts) */
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
		/** cash, banked across the session's matches like kills: the scoreboard starts it again
		 *  with the counters (followPlayer) */
		cash: integer('cash').notNull().default(0),
		/** seconds of this session spent with the player count at or under the server's seeding
		 *  threshold (0 while no seeding rule is on); what a Seeding reward rule adds up */
		seedSeconds: integer('seed_seconds').notNull().default(0)
	},
	// last_seen has no index on purpose: the heartbeat rewrites it for everyone online every 30 s,
	// and an indexed column would make each of those rewrites a new entry in every index. A read of
	// "seen since" adds (left_at IS NULL OR left_at >= since), which closing a session makes
	// equivalent (it sets last_seen = left_at), and the open index serves that (migration 0037).
	(t) => [
		index('player_sessions_open_idx').on(t.serverId, t.leftAt),
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
	(t) => [
		index('matches_server_idx').on(t.serverId, t.startedAt),
		/** the match in progress, which every status look and kill batch reads: one entry per server */
		index('matches_open_idx')
			.on(t.serverId, t.id)
			.where(sql`${t.endedAt} is null`),
		/** the matches that ended in a range's first, partial day (rangeBase) */
		index('matches_server_ended_idx').on(t.serverId, t.endedAt)
	]
);

/**
 * One row per kill the game's feed delivered (`[WDServerFeed]`, see docs/wardogs-api.md), with
 * what Warcon knew at receipt: the open match and both players' factions. History: never pruned;
 * a TimescaleDB hypertable with compression where the extension exists (migration 0019).
 */
export const kills = pgTable(
	'kills',
	{
		/** when Warcon received it, a second or two after the kill */
		ts: ts('ts').notNull(),
		serverId: text('server_id').notNull(),
		eventId: text('event_id').notNull(),
		/** the game's serverId: a per-boot instance id, not the join code */
		instanceId: text('instance_id').notNull(),
		/** the game's matchId: also per boot, as observed */
		matchId: text('match_id').notNull(),
		/** matches.id open on this server at receipt */
		matchRow: bigint('match_row', { mode: 'number' }),
		/** seconds on the match clock */
		eventTime: real('event_time').notNull(),
		map: text('map').notNull(),
		/** null: the environment */
		killerSteamId: text('killer_steam_id'),
		killerName: text('killer_name'),
		killerFaction: text('killer_faction'),
		victimSteamId: text('victim_steam_id').notNull(),
		victimName: text('victim_name').notNull(),
		victimFaction: text('victim_faction'),
		/** the raw weapon or vehicle tag, e.g. Id.Item.AK74M */
		cause: text('cause'),
		distanceM: real('distance_m'),
		headshot: boolean('headshot').notNull().default(false),
		/** the Suicide tag, or killer = victim */
		suicide: boolean('suicide').notNull().default(false),
		/** both factions known and equal, killer ≠ victim */
		teamKill: boolean('team_kill').notNull().default(false),
		/** the other context tags, short form: Penetration, Ricochet, RoadKill, VehicleExplosion, Falling, WeaponMelee */
		tags: jsonb('tags').notNull()
	},
	(t) => [
		// Not unique: a hypertable's unique indexes must include ts, so dedupe is a lookup (feed.ts).
		index('kills_event_idx').on(t.eventId),
		index('kills_server_ts_idx').on(t.serverId, t.ts.desc()),
		index('kills_killer_idx').on(t.killerSteamId, t.ts.desc()),
		index('kills_victim_idx').on(t.victimSteamId, t.ts.desc())
	]
);
export type KillRow = typeof kills.$inferSelect;

/**
 * The names the kill feed showed for a player that were not the one the server's player list held
 * for them then (a clan tag put on, taken off or swapped is the same name): one row per server,
 * player and name, with when it was first and last shown and, when it read as another listed
 * player's name, that player. Staff see them on the dossier as "in the kill feed as", and the
 * Players searches match them. Written by the worker as kill batches come in (feed-events.ts) and,
 * once, from the history (aliases.ts); kept for good. A name that differs is rare, so rows are few.
 */
export const playerAliases = pgTable(
	'player_aliases',
	{
		serverId: text('server_id').notNull(),
		steamId: text('steam_id').notNull(),
		/** as the feed showed it */
		name: text('name').notNull(),
		/** the listed player whose name it read as, the last time it was someone else's */
		holder: text('holder'),
		firstSeen: ts('first_seen').notNull(),
		lastSeen: ts('last_seen').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.serverId, t.steamId, t.name] }),
		index('player_aliases_steam_idx').on(t.steamId)
	]
);

/**
 * One row per player per match: the game's own scoreboard counters over the match (kills, deaths,
 * the change in cash) with the player's time on and side, and, on servers with a kill feed, what
 * the feed adds (headshots, team kills, suicides, vehicle kills, longest shot, best streaks).
 * Written by the worker when a player leaves and at the match end (match-players.ts); boards,
 * careers, the dossier and analytics read these rather than the sessions or the feed. Kept for
 * good; a server's stats purge deletes them with its matches. No foreign key, like kills.
 */
export const matchPlayers = pgTable(
	'match_players',
	{
		matchId: bigint('match_id', { mode: 'number' }).notNull(),
		serverId: text('server_id').notNull(),
		steamId: text('steam_id').notNull(),
		/** the name at the last look */
		name: text('name').notNull(),
		/** the last side seen that was a team on the scoreboard */
		faction: text('faction'),
		/** time on during the match */
		seconds: integer('seconds').notNull().default(0),
		kills: integer('kills').notNull().default(0),
		deaths: integer('deaths').notNull().default(0),
		/** the cash earned over the match: each run of the counters' last look less its first */
		cashDelta: integer('cash_delta').notNull().default(0),
		headshots: integer('headshots').notNull().default(0),
		teamKills: integer('team_kills').notNull().default(0),
		suicides: integer('suicides').notNull().default(0),
		vehicleKills: integer('vehicle_kills').notNull().default(0),
		/** null without a feed or a distance */
		longestM: real('longest_m'),
		killStreak: integer('kill_streak').notNull().default(0),
		deathStreak: integer('death_streak').notNull().default(0)
	},
	(t) => [
		primaryKey({ columns: [t.matchId, t.steamId] }),
		index('match_players_server_idx').on(t.serverId, t.matchId),
		index('match_players_steam_idx').on(t.steamId, t.matchId)
	]
);
export type MatchPlayerRow = typeof matchPlayers.$inferSelect;

/**
 * Each player's settled totals on a server, for the all-time reads (boards and their export,
 * career ranks, the placeholders' stats, the risk record), which add the open sessions: the sums
 * of the player's closed sessions and of their lines of ended matches, with the boards' result
 * rule. A row exists while the pair has either. Kept by triggers on player_sessions, matches and
 * match_players in the writer's own transaction, whoever the writer is (migration 0038 holds the
 * rules); the application only reads it, and takes player_totals_lock(server) before it closes a
 * session, ends a match or purges (totals.ts).
 */
export const playerTotals = pgTable(
	'player_totals',
	{
		serverId: text('server_id').notNull(),
		steamId: text('steam_id').notNull(),
		/** closed sessions */
		sessions: integer('sessions').notNull().default(0),
		/** SUM(EXTRACT(EPOCH FROM left_at - joined_at)) over them, exact */
		seconds: numeric('seconds').notNull().default('0'),
		seedSeconds: bigint('seed_seconds', { mode: 'number' }).notNull().default(0),
		cash: bigint('cash', { mode: 'number' }).notNull().default(0),
		/** MAX(last_seen) over them; null without one */
		lastSeen: ts('last_seen'),
		/** lines of ended matches */
		matches: integer('matches').notNull().default(0),
		kills: bigint('kills', { mode: 'number' }).notNull().default(0),
		deaths: bigint('deaths', { mode: 'number' }).notNull().default(0),
		headshots: bigint('headshots', { mode: 'number' }).notNull().default(0),
		teamKills: bigint('team_kills', { mode: 'number' }).notNull().default(0),
		suicides: bigint('suicides', { mode: 'number' }).notNull().default(0),
		vehicleKills: bigint('vehicle_kills', { mode: 'number' }).notNull().default(0),
		killStreak: integer('kill_streak').notNull().default(0),
		deathStreak: integer('death_streak').notNull().default(0),
		wins: integer('wins').notNull().default(0),
		losses: integer('losses').notNull().default(0),
		draws: integer('draws').notNull().default(0)
	},
	(t) => [primaryKey({ columns: [t.serverId, t.steamId] })]
);

/**
 * Each player's settled totals on a server per UTC day, for the ranged boards (7, 30 and 90 days),
 * which add the range's partial first day and the open sessions (rangeBase): the closed sessions'
 * time within the day, the joined_at of each closed session that crossed the day's midnight (what
 * a range starting the day before needs), and the count, seed time, cash and last sighting of the
 * sessions that left on the day; the lines of the matches that ended on it, with the boards' result
 * rule. A row exists while it holds any of them. Kept by the same triggers and lock as
 * player_totals (migration 0039 extends 0038's); the application only reads it.
 */
export const playerDays = pgTable(
	'player_days',
	{
		serverId: text('server_id').notNull(),
		/** the UTC date */
		day: date('day', { mode: 'string' }).notNull(),
		steamId: text('steam_id').notNull(),
		/** the closed sessions' seconds within the day, exact */
		seconds: numeric('seconds').notNull().default('0'),
		/** joined_at of each closed session that started before the day and left on it or later, in order; null when none */
		crossings: ts('crossings').array(),
		/** closed sessions that left on the day */
		sessions: integer('sessions').notNull().default(0),
		seedSeconds: bigint('seed_seconds', { mode: 'number' }).notNull().default(0),
		cash: bigint('cash', { mode: 'number' }).notNull().default(0),
		/** MAX(last_seen) over them; null without one */
		lastSeen: ts('last_seen'),
		/** lines of matches that ended on the day */
		matches: integer('matches').notNull().default(0),
		kills: bigint('kills', { mode: 'number' }).notNull().default(0),
		deaths: bigint('deaths', { mode: 'number' }).notNull().default(0),
		headshots: bigint('headshots', { mode: 'number' }).notNull().default(0),
		teamKills: bigint('team_kills', { mode: 'number' }).notNull().default(0),
		suicides: bigint('suicides', { mode: 'number' }).notNull().default(0),
		vehicleKills: bigint('vehicle_kills', { mode: 'number' }).notNull().default(0),
		killStreak: integer('kill_streak').notNull().default(0),
		deathStreak: integer('death_streak').notNull().default(0),
		wins: integer('wins').notNull().default(0),
		losses: integer('losses').notNull().default(0),
		draws: integer('draws').notNull().default(0)
	},
	(t) => [primaryKey({ columns: [t.serverId, t.day, t.steamId] })]
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
	/** unknown, public, private, or partial (only the first 200 friends checked) */
	friendsState: text('friends_state').notNull().default('unknown'),
	friendsTotal: integer('friends_total').notNull().default(0),
	friendsChecked: integer('friends_checked').notNull().default(0),
	bannedFriends: integer('banned_friends').notNull().default(0),
	friendsCheckedAt: ts('friends_checked_at'),
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
		kind: text('kind', {
			enum: [
				'welcome',
				'faction_change',
				'broadcast',
				'empty_reset',
				'risk_kick',
				'ping_kick',
				'restart_notice',
				'team_kill',
				'seed_reward',
				'match_broadcast',
				'name_filter',
				'kill_rate',
				'two_teams',
				'kill_distance',
				'afk_protection',
				'name_change',
				'bounty',
				'rotation_shuffle'
			]
		}).notNull(),
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
		/** with Automation ticked, the kinds of rule it carries; null = every kind */
		triggerKinds: jsonb('trigger_kinds'),
		/** null = every server in the org */
		serverIds: jsonb('server_ids'),
		enabled: boolean('enabled').notNull().default(true),
		/** keep a live status message per covered server, edited in place; see webhook-status.ts */
		statusEnabled: boolean('status_enabled').notNull().default(false),
		/** how the cards look; see $lib/status-styles */
		statusStyle: text('status_style', { enum: ['banner', 'compact', 'scoreboard'] })
			.notNull()
			.default('banner'),
		/** seconds between edits of one card (30-300); the per-server spacing applies on top */
		statusIntervalS: integer('status_interval_s').notNull().default(60),
		/** which links the card carries: the public status page, the public leaderboard, the panel */
		linkStatus: boolean('link_status').notNull().default(true),
		linkLeaderboard: boolean('link_leaderboard').notNull().default(true),
		linkPanel: boolean('link_panel').notNull().default(false),
		/** server id -> the Discord id of its message, once posted */
		statusMessages: jsonb('status_messages'),
		statusSentAt: ts('status_sent_at'),
		lastSentAt: ts('last_sent_at'),
		lastStatus: integer('last_status'),
		lastError: text('last_error').notNull().default(''),
		createdBy: text('created_by'),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [index('webhooks_org_idx').on(t.orgId)]
);

/**
 * An org's JSON webhooks: HTTPS addresses its owners run, sent a signed JSON POST per event they
 * tick (json-webhooks.ts keeps the records, json-webhook-send.ts sends). The address may carry a
 * token and the signing secret proves a request is Warcon's, so both are stored encrypted like an
 * RCON password; the panel only ever sees the host.
 */
export const jsonWebhooks = pgTable(
	'json_webhooks',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		label: text('label').notNull().default(''),
		urlEnc: text('url_enc').notNull(),
		/** what the panel shows instead of the address: its host, and port when not 443 */
		urlHint: text('url_hint').notNull().default(''),
		secretEnc: text('secret_enc').notNull(),
		/** event kinds to send; see json-webhook-send.ts */
		events: jsonb('events').notNull(),
		/** null = every server in the org */
		serverIds: jsonb('server_ids'),
		enabled: boolean('enabled').notNull().default(true),
		/** saved by the site owner, who may send to a private address, as they may add a server there */
		allowPrivate: boolean('allow_private').notNull().default(false),
		lastSentAt: ts('last_sent_at'),
		lastStatus: integer('last_status'),
		/** one of a few fixed phrases, never the reply's text */
		lastError: text('last_error').notNull().default(''),
		createdBy: text('created_by'),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [index('json_webhooks_org_idx').on(t.orgId)]
);

/**
 * The POSTs to JSON webhooks: one row per event per webhook that takes it (json-webhook-queue.ts).
 * A queue of its own, apart from the outbox on purpose: a receiver that is slow or down costs this
 * queue, never a game action. Rows are kept, like the outbox's.
 */
export const jsonWebhookPosts = pgTable(
	'json_webhook_posts',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		webhookId: text('webhook_id')
			.notNull()
			.references(() => jsonWebhooks.id, { onDelete: 'cascade' }),
		/**
		 * the server the event happened on; null for an organisation-wide event. No foreign key: a
		 * POST for a server since deleted is dropped when its turn comes, and deleting a server
		 * need not scan a table that is kept for good.
		 */
		serverId: text('server_id'),
		/** the event kind the webhook ticks (json-webhook-events.ts) */
		kind: text('kind').notNull(),
		/** "<event>:<key>": unique per event, the id receivers dedupe on */
		eventId: text('event_id').notNull(),
		/** the JSON body exactly as sent, final when queued, so every attempt sends the same bytes */
		body: text('body').notNull(),
		/** pending | sending | delivered | failed | skipped */
		state: text('state').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		notBefore: ts('not_before').notNull().defaultNow(),
		leaseUntil: ts('lease_until'),
		/** a status code or one of a few fixed phrases, never what the receiver answered */
		outcome: text('outcome').notNull().default(''),
		createdAt: ts('created_at').notNull().defaultNow(),
		doneAt: ts('done_at')
	},
	(t) => [
		uniqueIndex('json_webhook_posts_event_idx').on(t.webhookId, t.eventId),
		/**
		 * each webhook's open POSTs, oldest first: the claim steps from one webhook's oldest to the
		 * next webhook's, so it reads one entry per webhook with anything open, however many exist
		 */
		index('json_webhook_posts_next_idx')
			.on(t.webhookId, t.id)
			.where(sql`${t.state} in ('pending', 'sending')`),
		/** what is not finished, for the lease sweep and the backlog count; delivered rows stay out */
		index('json_webhook_posts_open_idx')
			.on(t.state)
			.where(sql`${t.state} in ('pending', 'sending')`)
	]
);

// ---- Organisation lists: bans and reserved slots kept in the panel and pushed to every server --

/**
 * A ban list or reserved-slot list an org owns. Servers subscribe through server_lists. Each org
 * has one default list per kind (is_default), which every org server takes; a server's own list
 * (server_id set) goes to that server alone. Any other org list is a reserved-slot group: on
 * between on_from and on_until, on every server or the ones its server_lists rows name, archived
 * rather than deleted.
 */
export const lists = pgTable(
	'lists',
	{
		id: text('id').primaryKey(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		/** set on a list that belongs to one server (its own reserved slots); null for the org's */
		serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['ban', 'reserve'] }).notNull(),
		name: text('name').notNull().default('Default'),
		/** the org's own list of its kind, which members' slots, rules and import write to */
		isDefault: boolean('is_default').notNull().default(false),
		/** a group: on from here (null: since it was switched on) */
		onFrom: ts('on_from'),
		/** a group: off from here (null: until switched off); a group that was never on has its creation time */
		onUntil: ts('on_until'),
		/** a group: every server of the org, now and later; else the servers in server_lists */
		everyServer: boolean('every_server').notNull().default(true),
		/** a group taken away: off for good, its entries and servers kept for the history */
		archivedAt: ts('archived_at'),
		/** reserved for sharing between orgs; unused for now */
		shareToken: text('share_token').unique(),
		createdBy: text('created_by'),
		createdAt: ts('created_at').notNull().defaultNow(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('lists_org_kind_name_uidx')
			.on(t.orgId, t.kind, sql`lower(${t.name})`)
			.where(sql`${t.serverId} is null and ${t.archivedAt} is null`),
		uniqueIndex('lists_org_default_uidx')
			.on(t.orgId, t.kind)
			.where(sql`${t.isDefault}`),
		uniqueIndex('lists_server_kind_uidx')
			.on(t.serverId, t.kind)
			.where(sql`${t.serverId} is not null`),
		// an org list that is not the default is a reserved-slot group
		check(
			'lists_group_kind',
			sql`${t.serverId} is not null or ${t.isDefault} or ${t.kind} = 'reserve'`
		),
		// only a group has a window, a choice of servers or an archive date
		check(
			'lists_group_shape',
			sql`(${t.serverId} is null and not ${t.isDefault}) or (${t.onFrom} is null and ${t.onUntil} is null and ${t.everyServer} and ${t.archivedAt} is null)`
		),
		check(
			'lists_window',
			sql`${t.onFrom} is null or ${t.onUntil} is null or ${t.onFrom} < ${t.onUntil}`
		)
	]
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
		index('list_entries_steam_idx').on(t.steamId),
		/** bans with an end date still in force: the worker looks for lapsed ones every few seconds */
		index('list_entries_expiry_idx')
			.on(t.expiresAt)
			.where(sql`${t.removedAt} is null and ${t.expiresAt} is not null`)
	]
);

/** Which lists apply to which server: every org list to every org server, a server's own to itself. */
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

/**
 * The poller's copy of each game server's reserved slots; sibling of server_bans. A row stands for
 * an id in the config document, in the running list, or both: the live builds read the document
 * at start, so between a write and the next restart the two differ.
 */
export const serverReserved = pgTable(
	'server_reserved',
	{
		serverId: text('server_id')
			.notNull()
			.references(() => servers.id, { onDelete: 'cascade' }),
		steamId: text('steam_id').notNull(),
		/** in the config document (the running list, on a build without one): what the sync plans against */
		configured: boolean('configured').notNull().default(true),
		/** in the running server's list: whom it holds a slot for now */
		live: boolean('live').notNull().default(true),
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

/** Per-server sync bookkeeping: last run and last error. */
export const serverListSync = pgTable('server_list_sync', {
	serverId: text('server_id')
		.primaryKey()
		.references(() => servers.id, { onDelete: 'cascade' }),
	syncedAt: ts('synced_at'),
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
	/** the build string from GET /v1/capabilities, e.g. ++Wardogs+Live-CL-501228; '' until read */
	build: text('build').notNull().default(''),
	/** GET /v1/server-id on builds that serve it (CL-501228+): the join code; '' otherwise */
	gameServerId: text('game_server_id').notNull().default(''),
	/** when the game process started, from uptimeSeconds on GET /v1/health; null until read or unserved */
	startedAt: ts('started_at'),
	/** MaxReservedSlots from the config document: player slots held back for reserved players; null until read */
	reservedSlots: integer('reserved_slots'),
	/** RestartTimeUtc ("HH:MM") the running process started with; null when unset or not yet read */
	restartTimeUtc: text('restart_time_utc'),
	/** RestartTimeUtc as the config document holds it now (in effect from the next restart) */
	restartTimeUtcFile: text('restart_time_utc_file'),
	/** Status as the action registry shapes it */
	status: jsonb('status'),
	/** Player[] as the action registry shapes it */
	players: jsonb('players'),
	playerCount: integer('player_count').notNull().default(0),
	statusAt: ts('status_at'),
	playersAt: ts('players_at'),
	/** last attempt, successful or not */
	observedAt: ts('observed_at'),
	/** when the last kill feed batch arrived (written by the web process that took it) */
	feedAt: ts('feed_at'),
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
		/** the rows still to deliver; finished rows, kept for good, stay out of it */
		index('outbox_pending_idx')
			.on(t.state, t.notBefore)
			.where(sql`${t.state} in ('pending', 'sending')`),
		index('outbox_server_idx').on(t.serverId, t.createdAt.desc())
	]
);

/**
 * Hourly rollups of samples (rollups.ts fills them; analytics.ts reads them for the long ranges).
 * Durations are seconds of cover; player_s is player-count × seconds while up. Kept for good.
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
export type OrgRoleRow = typeof orgRoles.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type SampleRow = typeof samples.$inferSelect;
export type SteamProfileRow = typeof steamProfiles.$inferSelect;
export type TriggerRow = typeof triggers.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type JsonWebhookRow = typeof jsonWebhooks.$inferSelect;
export type JsonWebhookPostRow = typeof jsonWebhookPosts.$inferSelect;
export type PlayerNoteRow = typeof playerNotes.$inferSelect;
export type PlayerMarkRow = typeof playerMarks.$inferSelect;
export type ListRow = typeof lists.$inferSelect;
export type ListEntryRow = typeof listEntries.$inferSelect;
export type ServerListStateRow = typeof serverListState.$inferSelect;
export type ServerListSyncRow = typeof serverListSync.$inferSelect;
export type ServerLiveRow = typeof serverLive.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
