// Player intelligence: the dossier (history across an org's servers, Steam data, risk, notes,
// watchlist) and the marks the players table shows next to each connected player.
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, str } from './http';
import { queryAudit, writeAudit } from './audit';
import {
	accessibleServers,
	auditVisibility,
	getOrg,
	listsRoleFor,
	type ServerAccess,
	type ServerRow,
	type SessionUser
} from './access';
import { orgListMembership } from './lists';
import {
	kills,
	playerMarks,
	playerNotes,
	playerSessions,
	serverBans,
	servers,
	triggers
} from './db/schema';
import { getProfiles, isSteamId, steamEnabled, type SteamProfileRow } from './steam';
import { accountAgeDays, assessRisk, namesResemble, type Risk, type RiskPerformance } from './risk';
import { riskPerformanceFor } from './leaderboards';
import { seedBalanceSeconds } from './seed-progress';
import type { SeedRewardConfig } from './trigger-rules';
import type {
	DossierView,
	PlayerCombat,
	PlayerMark,
	PlayerNoteView,
	SteamView,
	CombatSummary
} from '$lib/types';
import { killView } from './feed';

export { requireSteamId } from './steam';

const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export function steamView(row: SteamProfileRow | undefined | null): SteamView | null {
	if (!row) return null;
	return {
		persona: row.persona,
		avatar: row.avatar,
		profileUrl: row.profileUrl,
		public: row.public,
		accountCreatedAt: iso(row.accountCreatedAt),
		accountAgeDays: accountAgeDays(row.accountCreatedAt),
		vacBans: row.vacBans,
		gameBans: row.gameBans,
		daysSinceLastBan: row.daysSinceLastBan,
		communityBanned: row.communityBanned,
		economyBan: row.economyBan,
		friendsState: row.friendsState,
		friendsTotal: row.friendsTotal,
		friendsChecked: row.friendsChecked,
		bannedFriends: row.bannedFriends,
		fetchedAt: row.fetchedAt.toISOString(),
		error: row.error
	};
}

/** Every server of an org (not filtered by who is asking): for the poller and trigger engine. */
export async function orgServers(env: Env, orgId: string): Promise<{ id: string; name: string }[]> {
	return env.db
		.select({ id: servers.id, name: servers.name })
		.from(servers)
		.where(eq(servers.orgId, orgId))
		.orderBy(asc(servers.sortOrder), asc(servers.name));
}

export interface BanHit {
	steamId: string;
	serverId: string;
	serverName: string;
	reason: string;
	bannedBy: string;
}

/** The poller's snapshot of the ban lists of these servers. */
async function bansOn(env: Env, serverIds: string[]): Promise<BanHit[]> {
	if (!serverIds.length) return [];
	const rows = await env.db
		.select({
			steamId: serverBans.steamId,
			serverId: serverBans.serverId,
			serverName: servers.name,
			reason: serverBans.reason,
			bannedBy: serverBans.bannedBy
		})
		.from(serverBans)
		.innerJoin(servers, eq(servers.id, serverBans.serverId))
		.where(inArray(serverBans.serverId, serverIds))
		.limit(5000);
	return rows;
}

/** Last name each SteamID was seen with on these servers. */
async function lastNames(
	env: Env,
	serverIds: string[],
	steamIds: string[]
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (!serverIds.length || !steamIds.length) return out;
	const rows = await env.db.execute<{ steamId: string; name: string }>(sql`
		SELECT DISTINCT ON (steam_id) steam_id AS "steamId", name
		  FROM player_sessions
		 WHERE server_id IN ${serverIds} AND steam_id IN ${steamIds}
		 ORDER BY steam_id, last_seen DESC`);
	for (const r of rows) out.set(r.steamId, r.name);
	return out;
}

export interface LocalSignals {
	watched: { reason: string } | null;
	bannedOn: BanHit[];
	resembles: { name: string; steamId: string; serverName: string }[];
}

/**
 * What the panel itself knows about each player: watchlist, bans on the org's other servers,
 * and banned players whose last known name looks like theirs.
 */
export async function localSignals(
	env: Env,
	orgId: string,
	orgServerIds: string[],
	currentServerId: string | null,
	players: { steamId: string; name: string }[],
	/** false skips the lookalike names (the costly part: players x banned names), left empty */
	withResembles = true
): Promise<Map<string, LocalSignals>> {
	const out = new Map<string, LocalSignals>();
	const ids = [...new Set(players.map((p) => p.steamId).filter(isSteamId))];
	if (!ids.length) return out;
	const [marks, bans] = await Promise.all([
		env.db
			.select({ steamId: playerMarks.steamId, reason: playerMarks.reason })
			.from(playerMarks)
			.where(
				and(
					eq(playerMarks.orgId, orgId),
					eq(playerMarks.watched, true),
					inArray(playerMarks.steamId, ids)
				)
			),
		bansOn(env, orgServerIds)
	]);
	const watched = new Map(marks.map((m) => [m.steamId, { reason: m.reason }]));
	const bannedIds = [...new Set(bans.map((b) => b.steamId))];
	const names = withResembles
		? await lastNames(env, orgServerIds, bannedIds.slice(0, 2000))
		: new Map<string, string>();
	const bannedNamed = bannedIds
		.map((id) => ({ steamId: id, name: names.get(id) || '' }))
		.filter((b) => b.name);
	const serverOfBan = new Map<string, string>();
	for (const b of bans) if (!serverOfBan.has(b.steamId)) serverOfBan.set(b.steamId, b.serverName);
	for (const p of players) {
		if (!isSteamId(p.steamId) || out.has(p.steamId)) continue;
		const bannedOn = bans.filter((b) => b.steamId === p.steamId && b.serverId !== currentServerId);
		const resembles = bannedNamed
			.filter((b) => b.steamId !== p.steamId && namesResemble(p.name, b.name))
			.slice(0, 5)
			.map((b) => ({
				name: b.name,
				steamId: b.steamId,
				serverName: serverOfBan.get(b.steamId) || ''
			}));
		out.set(p.steamId, { watched: watched.get(p.steamId) ?? null, bannedOn, resembles });
	}
	return out;
}

export function riskFor(
	env: Env,
	profile: SteamProfileRow | undefined,
	local: LocalSignals | undefined,
	/** recorded games on the servers the reader can open, never the whole org's */
	performance: RiskPerformance | undefined,
	/** false leaves the watchlist reason out of the risk line: it is a staff note */
	staff = true
): Risk {
	return assessRisk({
		profile: profile ?? null,
		steamEnabled: steamEnabled(env),
		watched: local?.watched ? { reason: staff ? local.watched.reason : '' } : null,
		bannedOn: local?.bannedOn ?? [],
		resembles: local?.resembles ?? [],
		performance: performance ?? null
	});
}

/** Marks for the players table: watchlist, first visit, risk. One batch per refresh. */
export async function marksFor(
	env: Env,
	user: SessionUser,
	server: ServerRow,
	access: ServerAccess,
	players: { steamId: string; name: string }[]
): Promise<PlayerMark[]> {
	const ids = [...new Set(players.map((p) => p.steamId).filter(isSteamId))];
	if (!ids.length) return [];
	// Bans elsewhere in the org count only where the reader could open them, as in the dossier.
	const orgIds = (await accessibleServers(env, user, server.orgId)).map((s) => s.id);
	const staff = access.caps.has('players.notes') || access.caps.has('players.notes.manage');
	const [profiles, local, counts, performance] = await Promise.all([
		getProfiles(env, ids),
		localSignals(env, server.orgId, orgIds, server.id, players),
		env.db
			.select({ steamId: playerSessions.steamId, n: sql<number>`count(*)` })
			.from(playerSessions)
			.where(and(eq(playerSessions.serverId, server.id), inArray(playerSessions.steamId, ids)))
			.groupBy(playerSessions.steamId),
		riskPerformanceFor(env, orgIds, ids)
	]);
	const visits = new Map(counts.map((c) => [c.steamId, num(c.n)]));
	return ids.map((steamId) => {
		const l = local.get(steamId);
		return {
			steamId,
			watched: !!l?.watched,
			reason: staff ? (l?.watched?.reason ?? '') : '',
			firstVisit: (visits.get(steamId) ?? 0) <= 1,
			risk: riskFor(env, profiles.get(steamId), l, performance.get(steamId), staff)
		};
	});
}

// ---- dossier ------------------------------------------------------------------------------------

export async function dossier(
	env: Env,
	user: SessionUser,
	server: ServerRow,
	access: ServerAccess,
	steamId: string,
	opts: { refreshSteam?: boolean } = {}
): Promise<DossierView> {
	const visible = (await accessibleServers(env, user)).filter((s) => s.orgId === server.orgId);
	const ids = visible.map((s) => s.id);
	const nameOf = new Map(visible.map((s) => [s.id, s.name]));
	const db = env.db;

	const [summary] = await db.execute<{
		sessions: string;
		minutes: string | null;
		cash: string | null;
		firstSeen: Date | null;
		lastSeen: Date | null;
	}>(sql`
		SELECT COUNT(*) AS sessions,
		       SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - joined_at))) / 60 AS minutes,
		       SUM(cash) AS cash,
		       MIN(joined_at) AS "firstSeen", MAX(last_seen) AS "lastSeen"
		  FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${ids.length ? ids : ['']}`);
	const [longestAlive] = ids.length
		? await db.execute<{ seconds: string | null }>(sql`
			WITH tracked AS (
				SELECT ps.id, ps.server_id, ps.joined_at,
				       COALESCE(ps.left_at, ps.last_seen) AS ended_at
				  FROM player_sessions ps
				  JOIN servers s ON s.id = ps.server_id
				 WHERE ps.steam_id = ${steamId} AND ps.server_id IN ${ids}
				   AND COALESCE(ps.left_at, ps.last_seen) > ps.joined_at
				   AND (s.feed_token_hash IS NOT NULL OR EXISTS (
				       SELECT 1 FROM kills k
				        WHERE k.server_id = ps.server_id AND k.event_type = 'killed'
				          AND k.parsed_kill AND k.victim_steam_id = ${steamId}
				          AND k.ts BETWEEN ps.joined_at AND COALESCE(ps.left_at, ps.last_seen)
				   ))
			), boundaries AS (
				SELECT id, joined_at AS at FROM tracked
				UNION
				SELECT id, ended_at AS at FROM tracked
				UNION
				SELECT t.id, k.ts AS at FROM tracked t JOIN kills k
				  ON k.server_id = t.server_id AND k.ts BETWEEN t.joined_at AND t.ended_at
				 WHERE k.event_type = 'killed' AND k.parsed_kill AND k.victim_steam_id = ${steamId}
				UNION
				SELECT t.id, m.started_at AS at FROM tracked t JOIN matches m
				  ON m.server_id = t.server_id AND m.started_at > t.joined_at
				 AND m.started_at < t.ended_at
			), intervals AS (
				SELECT at - LAG(at) OVER (PARTITION BY id ORDER BY at) AS alive_for
				  FROM boundaries
			)
			SELECT MAX(EXTRACT(EPOCH FROM alive_for)) AS seconds
			  FROM intervals WHERE alive_for IS NOT NULL`)
		: [];
	const perServer = ids.length
		? await db.execute<{
				serverId: string;
				sessions: string;
				minutes: string;
				cash: string;
				lastSeen: Date;
			}>(sql`
			SELECT server_id AS "serverId", COUNT(*) AS sessions,
			       SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - joined_at))) / 60 AS minutes,
			       SUM(cash) AS cash,
			       MAX(last_seen) AS "lastSeen"
			  FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${ids}
			 GROUP BY server_id ORDER BY "lastSeen" DESC`)
		: [];
	// Kills and deaths are the game's own counters, summed from the player's lines of the matches
	// that ended (the same rows the boards and careers read, so every page agrees).
	const recorded = ids.length
		? await db.execute<{ serverId: string; kills: string; deaths: string }>(sql`
			SELECT p.server_id AS "serverId", SUM(p.kills) AS kills, SUM(p.deaths) AS deaths
			  FROM match_players p JOIN matches m ON m.id = p.match_id
			 WHERE p.steam_id = ${steamId} AND p.server_id IN ${ids} AND m.ended_at IS NOT NULL
			 GROUP BY p.server_id`)
		: [];
	const recordedOn = new Map(recorded.map((r) => [r.serverId, r]));
	const recordedAll = { kills: 0, deaths: 0 };
	for (const r of recorded) {
		recordedAll.kills += num(r.kills);
		recordedAll.deaths += num(r.deaths);
	}
	const recent = ids.length
		? await db
				.select()
				.from(playerSessions)
				.where(and(eq(playerSessions.steamId, steamId), inArray(playerSessions.serverId, ids)))
				.orderBy(desc(playerSessions.lastSeen))
				.limit(25)
		: [];
	const names = ids.length
		? await db.execute<{ name: string }>(sql`
			SELECT name FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${ids}
			 GROUP BY name ORDER BY MAX(last_seen) DESC LIMIT 10`)
		: [];
	const online = recent.find((s) => s.leftAt === null) ?? null;
	const name = names[0]?.name || steamId;

	const [
		profiles,
		local,
		[mark],
		noteRows,
		actions,
		org,
		listsRole,
		allOrgServers,
		combat,
		performance,
		seedRows
	] = await Promise.all([
		getProfiles(env, [steamId], {
			refresh: !!opts.refreshSteam,
			awaitFriends: !!opts.refreshSteam
		}),
		localSignals(env, server.orgId, ids, null, [{ steamId, name }]),
		db
			.select()
			.from(playerMarks)
			.where(and(eq(playerMarks.orgId, server.orgId), eq(playerMarks.steamId, steamId)))
			.limit(1),
		db
			.select()
			.from(playerNotes)
			.where(and(eq(playerNotes.orgId, server.orgId), eq(playerNotes.steamId, steamId)))
			.orderBy(desc(playerNotes.id))
			.limit(100),
		auditVisibility(env, user).then((visibleTo) =>
			queryAudit(env, {
				target: steamId,
				scope: { orgId: server.orgId, serverIds: ids },
				visibleTo,
				limit: 50
			})
		),
		getOrg(env, server.orgId),
		listsRoleFor(env, user, server.orgId),
		orgServers(env, server.orgId),
		playerCombat(env, ids, nameOf, steamId),
		riskPerformanceFor(env, ids, [steamId]),
		db
			.select({ config: triggers.config, state: triggers.state })
			.from(triggers)
			.where(
				and(
					eq(triggers.serverId, server.id),
					eq(triggers.kind, 'seed_reward'),
					eq(triggers.enabled, true)
				)
			)
			.limit(1)
	]);
	const seedRow = seedRows[0];
	const seedConfig = seedRow?.config as Partial<SeedRewardConfig> | undefined;
	const requiredSeedMinutes = num(seedConfig?.minutes);
	const l = local.get(steamId);
	const admin = access.caps.has('players.notes.manage');
	// What staff wrote about the player is for those who may write it; an org list entry (its
	// reason, who added it, where it stands on every server) for those who may edit that list.
	const staff = admin || access.caps.has('players.notes');
	const membership =
		org && listsRole
			? await orgListMembership(env, org, steamId, listsRole.kinds)
			: { ban: null, reserve: null };
	return {
		steamId,
		name,
		names: names.map((n) => n.name),
		online: online
			? { serverId: online.serverId, serverName: nameOf.get(online.serverId) || '' }
			: null,
		orgServerCount: allOrgServers.length,
		orgLists: {
			...membership,
			canBan: !!listsRole?.kinds.includes('ban'),
			canReserve: !!listsRole?.kinds.includes('reserve')
		},
		steamEnabled: steamEnabled(env),
		steam: steamView(profiles.get(steamId)),
		risk: riskFor(env, profiles.get(steamId), l, performance.get(steamId), staff),
		watch: {
			watched: !!mark?.watched,
			reason: staff ? (mark?.reason ?? '') : '',
			updatedByName: staff ? (mark?.updatedByName ?? '') : '',
			updatedAt: iso(mark?.updatedAt)
		},
		bannedOn: (l?.bannedOn ?? []).map((b) => ({
			serverId: b.serverId,
			serverName: b.serverName,
			reason: b.reason,
			bannedBy: b.bannedBy
		})),
		combat,
		summary: {
			sessions: num(summary?.sessions),
			minutes: Math.round(num(summary?.minutes)),
			kills: recordedAll.kills,
			deaths: recordedAll.deaths,
			cash: num(summary?.cash),
			longestAliveSeconds:
				longestAlive?.seconds === null || longestAlive?.seconds === undefined
					? null
					: Math.round(num(longestAlive.seconds)),
			seedReward:
				seedRow && requiredSeedMinutes > 0
					? {
							minutes: Math.floor(seedBalanceSeconds(seedRow.state, steamId) / 60),
							requiredMinutes: requiredSeedMinutes
						}
					: null,
			firstSeen: iso(summary?.firstSeen ? new Date(summary.firstSeen) : null),
			lastSeen: iso(summary?.lastSeen ? new Date(summary.lastSeen) : null)
		},
		perServer: perServer.map((r) => ({
			serverId: r.serverId,
			serverName: nameOf.get(r.serverId) || r.serverId,
			sessions: num(r.sessions),
			minutes: Math.round(num(r.minutes)),
			kills: num(recordedOn.get(r.serverId)?.kills),
			deaths: num(recordedOn.get(r.serverId)?.deaths),
			cash: num(r.cash),
			lastSeen: new Date(r.lastSeen).toISOString()
		})),
		recent: recent.map((s) => ({
			id: s.id,
			serverId: s.serverId,
			serverName: nameOf.get(s.serverId) || s.serverId,
			name: s.name,
			faction: s.faction,
			joinedAt: s.joinedAt.toISOString(),
			lastSeen: s.lastSeen.toISOString(),
			leftAt: iso(s.leftAt),
			minutes: Math.round(((s.leftAt ?? new Date()).getTime() - s.joinedAt.getTime()) / 60000),
			seedMinutes: Math.round(s.seedSeconds / 60),
			kills: s.kills,
			deaths: s.deaths,
			cash: s.cash
		})),
		notes: (staff ? noteRows : []).map((n) => ({
			id: n.id,
			authorId: n.authorId,
			authorName: n.authorName,
			body: n.body,
			createdAt: n.createdAt.toISOString(),
			deletable: admin || n.authorId === user.id
		})),
		actions: actions.entries.map((a) => ({
			id: a.id,
			ts: a.ts.toISOString(),
			actorName: a.actorName,
			action: a.action,
			serverName: a.serverName,
			outcome: a.outcome,
			message: a.message
		}))
	};
}

// ---- notes and watchlist ------------------------------------------------------------------------

export async function addNote(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	steamId: string,
	bodyIn: unknown
): Promise<PlayerNoteView> {
	const body = str(bodyIn, 2000);
	if (!body) throw new ApiError(400, 'The note is empty.');
	const [row] = await env.db
		.insert(playerNotes)
		.values({ orgId: server.orgId, steamId, authorId: user.id, authorName: user.username, body })
		.returning();
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'player',
		action: 'player.note',
		target: steamId,
		outcome: 'ok',
		message: body.slice(0, 200),
		detail: { noteId: row.id }
	});
	return {
		id: row.id,
		authorId: row.authorId,
		authorName: row.authorName,
		body: row.body,
		createdAt: row.createdAt.toISOString(),
		deletable: true
	};
}

export async function deleteNote(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	access: ServerAccess,
	steamId: string,
	noteId: number
): Promise<void> {
	const [note] = await env.db
		.select()
		.from(playerNotes)
		.where(
			and(
				eq(playerNotes.id, noteId),
				eq(playerNotes.orgId, server.orgId),
				eq(playerNotes.steamId, steamId)
			)
		)
		.limit(1);
	if (!note) throw new ApiError(404, 'Note not found.');
	if (note.authorId !== user.id && !access.caps.has('players.notes.manage'))
		throw new ApiError(
			403,
			'Only the author, or a role with "Others\' notes", can delete this note.',
			'forbidden'
		);
	await env.db.delete(playerNotes).where(eq(playerNotes.id, noteId));
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'player',
		action: 'player.note.delete',
		target: steamId,
		outcome: 'ok',
		detail: { noteId, author: note.authorName }
	});
}

export async function setWatch(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	steamId: string,
	watched: boolean,
	reasonIn: unknown
): Promise<void> {
	const reason = watched ? str(reasonIn, 300) : '';
	await env.db
		.insert(playerMarks)
		.values({
			orgId: server.orgId,
			steamId,
			watched,
			reason,
			updatedBy: user.id,
			updatedByName: user.username,
			updatedAt: new Date()
		})
		.onConflictDoUpdate({
			target: [playerMarks.orgId, playerMarks.steamId],
			set: {
				watched,
				reason,
				updatedBy: user.id,
				updatedByName: user.username,
				updatedAt: new Date()
			}
		});
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'player',
		action: 'player.watch',
		target: steamId,
		outcome: 'ok',
		message: watched
			? `Added to the watchlist${reason ? `: ${reason}` : ''}`
			: 'Removed from the watchlist',
		detail: { watched, reason }
	});
}

/** Players whose sessions on this org's servers the caller may not see are simply absent: nothing to guard. */
export const _internal = { bansOn, lastNames, ne, isNull };

/** The player's kill-feed record across these servers, or null when none of them has a feed. */
async function playerCombat(
	env: Env,
	serverIds: string[],
	nameOf: Map<string, string>,
	steamId: string
): Promise<PlayerCombat | null> {
	const summary = await combatSummary(env, serverIds, steamId);
	if (!summary) return null;
	const recent = await env.db
		.select()
		.from(kills)
		.where(
			and(
				inArray(kills.serverId, serverIds),
				eq(kills.eventType, 'killed'),
				eq(kills.parsedKill, true),
				or(eq(kills.killerSteamId, steamId), eq(kills.victimSteamId, steamId))
			)
		)
		.orderBy(desc(kills.ts))
		.limit(25);
	return {
		...summary,
		recent: recent.map((r) => ({
			...killView(r),
			serverId: r.serverId,
			serverName: nameOf.get(r.serverId) || r.serverId
		}))
	};
}

/**
 * The totals, weapons, most-killed and nemeses without the recent rows: the public career page
 * shows exactly this. Null when none of the servers has a feed and the player is in no kill.
 */
export async function combatSummary(
	env: Env,
	serverIds: string[],
	steamId: string
): Promise<CombatSummary | null> {
	if (!serverIds.length) return null;
	const db = env.db;
	const [feed] = await db
		.select({ n: sql<number>`COUNT(*)` })
		.from(servers)
		.where(and(inArray(servers.id, serverIds), sql`${servers.feedTokenHash} IS NOT NULL`));
	const [t] = await db.execute<{
		kills: string;
		deaths: string;
		headshots: string;
		teamKills: string;
		teamKilled: string;
		suicides: string;
		avg: string | null;
		longest: string | null;
	}>(sql`
		SELECT COUNT(*) FILTER (WHERE killer_steam_id = ${steamId} AND NOT suicide) AS kills,
		       COUNT(*) FILTER (WHERE victim_steam_id = ${steamId}) AS deaths,
		       COUNT(*) FILTER (WHERE killer_steam_id = ${steamId} AND headshot AND NOT suicide) AS headshots,
		       COUNT(*) FILTER (WHERE killer_steam_id = ${steamId} AND team_kill) AS "teamKills",
		       COUNT(*) FILTER (WHERE victim_steam_id = ${steamId} AND team_kill) AS "teamKilled",
		       COUNT(*) FILTER (WHERE victim_steam_id = ${steamId} AND suicide) AS suicides,
		       AVG(distance_m) FILTER (WHERE killer_steam_id = ${steamId} AND NOT suicide) AS avg,
		       MAX(distance_m) FILTER (WHERE killer_steam_id = ${steamId} AND NOT suicide) AS longest
		  FROM kills WHERE event_type = 'killed' AND parsed_kill AND server_id IN ${serverIds}
		   AND (killer_steam_id = ${steamId} OR victim_steam_id = ${steamId})`);
	if (!num(feed?.n) && !num(t?.kills) && !num(t?.deaths)) return null;
	const [causes, victims, nemeses] = await Promise.all([
		db.execute<{ cause: string; kills: string }>(sql`
			SELECT cause, COUNT(*) AS kills FROM kills
			 WHERE event_type = 'killed' AND parsed_kill AND server_id IN ${serverIds}
			   AND killer_steam_id = ${steamId} AND NOT suicide AND cause IS NOT NULL
			 GROUP BY cause ORDER BY kills DESC LIMIT 8`),
		db.execute<{ steamId: string; name: string; kills: string }>(sql`
			SELECT victim_steam_id AS "steamId", MAX(victim_name) AS name, COUNT(*) AS kills FROM kills
			 WHERE event_type = 'killed' AND parsed_kill AND server_id IN ${serverIds}
			   AND killer_steam_id = ${steamId} AND NOT suicide
			 GROUP BY victim_steam_id ORDER BY kills DESC LIMIT 5`),
		db.execute<{ steamId: string; name: string; deaths: string }>(sql`
			SELECT killer_steam_id AS "steamId", MAX(killer_name) AS name, COUNT(*) AS deaths FROM kills
			 WHERE event_type = 'killed' AND parsed_kill AND server_id IN ${serverIds}
			   AND victim_steam_id = ${steamId} AND killer_steam_id IS NOT NULL AND NOT suicide
			 GROUP BY killer_steam_id ORDER BY deaths DESC LIMIT 5`)
	]);
	return {
		kills: num(t?.kills),
		deaths: num(t?.deaths),
		headshots: num(t?.headshots),
		teamKills: num(t?.teamKills),
		teamKilled: num(t?.teamKilled),
		suicides: num(t?.suicides),
		avgDistanceM: t?.avg === null || t?.avg === undefined ? null : Math.round(num(t.avg)),
		longestM: t?.longest === null || t?.longest === undefined ? null : Math.round(num(t.longest)),
		causes: causes.map((r) => ({ cause: r.cause, kills: num(r.kills) })),
		victims: victims.map((r) => ({ steamId: r.steamId, name: r.name, kills: num(r.kills) })),
		nemeses: nemeses.map((r) => ({ steamId: r.steamId, name: r.name, deaths: num(r.deaths) }))
	};
}
