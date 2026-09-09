// Player intelligence: the dossier (history across an org's servers, Steam data, risk, notes,
// watchlist) and the marks the players table shows next to each connected player.
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Env } from './env';
import { pollSeconds } from './env';
import { ApiError, str } from './http';
import { queryAudit, writeAudit } from './audit';
import {
	accessibleServers,
	auditVisibility,
	roleAtLeast,
	type ServerRole,
	type ServerRow,
	type SessionUser
} from './access';
import { playerMarks, playerNotes, playerSessions, serverBans, servers } from './db/schema';
import { getProfiles, isSteamId, steamEnabled, type SteamProfileRow } from './steam';
import { accountAgeDays, assessRisk, namesResemble, type Risk } from './risk';
import type { DossierView, PlayerMark, PlayerNoteView, SteamView } from '$lib/types';

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
	players: { steamId: string; name: string }[]
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
	const names = await lastNames(env, orgServerIds, bannedIds.slice(0, 2000));
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
	local: LocalSignals | undefined
): Risk {
	return assessRisk({
		profile: profile ?? null,
		steamEnabled: steamEnabled(env),
		watched: local?.watched ?? null,
		bannedOn: local?.bannedOn ?? [],
		resembles: local?.resembles ?? []
	});
}

/** Marks for the players table: watchlist, first visit, risk. One batch per refresh. */
export async function marksFor(
	env: Env,
	server: ServerRow,
	players: { steamId: string; name: string }[]
): Promise<PlayerMark[]> {
	const ids = [...new Set(players.map((p) => p.steamId).filter(isSteamId))];
	if (!ids.length) return [];
	const orgIds = (await orgServers(env, server.orgId)).map((s) => s.id);
	const [profiles, local, counts] = await Promise.all([
		getProfiles(env, ids),
		localSignals(env, server.orgId, orgIds, server.id, players),
		env.db
			.select({ steamId: playerSessions.steamId, n: sql<number>`count(*)` })
			.from(playerSessions)
			.where(and(eq(playerSessions.serverId, server.id), inArray(playerSessions.steamId, ids)))
			.groupBy(playerSessions.steamId)
	]);
	const visits = new Map(counts.map((c) => [c.steamId, num(c.n)]));
	return ids.map((steamId) => {
		const l = local.get(steamId);
		return {
			steamId,
			watched: !!l?.watched,
			reason: l?.watched?.reason ?? '',
			firstVisit: (visits.get(steamId) ?? 0) <= 1,
			risk: riskFor(env, profiles.get(steamId), l)
		};
	});
}

// ---- dossier ------------------------------------------------------------------------------------

export async function dossier(
	env: Env,
	user: SessionUser,
	server: ServerRow,
	role: ServerRole,
	steamId: string,
	opts: { refreshSteam?: boolean } = {}
): Promise<DossierView> {
	const visible = (await accessibleServers(env, user)).filter((s) => s.orgId === server.orgId);
	const ids = visible.map((s) => s.id);
	const nameOf = new Map(visible.map((s) => [s.id, s.name]));
	const poll = pollSeconds(env) || 20;
	const db = env.db;

	const [summary] = await db.execute<{
		sessions: string;
		minutes: string | null;
		kills: string | null;
		deaths: string | null;
		firstSeen: Date | null;
		lastSeen: Date | null;
	}>(sql`
		SELECT COUNT(*) AS sessions,
		       SUM(EXTRACT(EPOCH FROM (last_seen - joined_at)) + ${poll}) / 60 AS minutes,
		       SUM(kills) AS kills, SUM(deaths) AS deaths,
		       MIN(joined_at) AS "firstSeen", MAX(last_seen) AS "lastSeen"
		  FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${ids.length ? ids : ['']}`);
	const perServer = ids.length
		? await db.execute<{
				serverId: string;
				sessions: string;
				minutes: string;
				kills: string;
				deaths: string;
				lastSeen: Date;
			}>(sql`
			SELECT server_id AS "serverId", COUNT(*) AS sessions,
			       SUM(EXTRACT(EPOCH FROM (last_seen - joined_at)) + ${poll}) / 60 AS minutes,
			       SUM(kills) AS kills, SUM(deaths) AS deaths, MAX(last_seen) AS "lastSeen"
			  FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${ids}
			 GROUP BY server_id ORDER BY "lastSeen" DESC`)
		: [];
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

	const [profiles, local, [mark], noteRows, actions] = await Promise.all([
		getProfiles(env, [steamId], { refresh: !!opts.refreshSteam }),
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
		)
	]);
	const l = local.get(steamId);
	const admin = roleAtLeast(role, 'admin');
	return {
		steamId,
		name,
		names: names.map((n) => n.name),
		online: online
			? { serverId: online.serverId, serverName: nameOf.get(online.serverId) || '' }
			: null,
		steamEnabled: steamEnabled(env),
		steam: steamView(profiles.get(steamId)),
		risk: riskFor(env, profiles.get(steamId), l),
		watch: {
			watched: !!mark?.watched,
			reason: mark?.reason ?? '',
			updatedByName: mark?.updatedByName ?? '',
			updatedAt: iso(mark?.updatedAt)
		},
		bannedOn: (l?.bannedOn ?? []).map((b) => ({
			serverId: b.serverId,
			serverName: b.serverName,
			reason: b.reason,
			bannedBy: b.bannedBy
		})),
		summary: {
			sessions: num(summary?.sessions),
			minutes: Math.round(num(summary?.minutes)),
			kills: num(summary?.kills),
			deaths: num(summary?.deaths),
			firstSeen: iso(summary?.firstSeen ? new Date(summary.firstSeen) : null),
			lastSeen: iso(summary?.lastSeen ? new Date(summary.lastSeen) : null)
		},
		perServer: perServer.map((r) => ({
			serverId: r.serverId,
			serverName: nameOf.get(r.serverId) || r.serverId,
			sessions: num(r.sessions),
			minutes: Math.round(num(r.minutes)),
			kills: num(r.kills),
			deaths: num(r.deaths),
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
			minutes: Math.round((s.lastSeen.getTime() - s.joinedAt.getTime()) / 60000 + poll / 60),
			kills: s.kills,
			deaths: s.deaths,
			cash: s.cash
		})),
		notes: noteRows.map((n) => ({
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
	role: ServerRole,
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
	if (note.authorId !== user.id && !roleAtLeast(role, 'admin'))
		throw new ApiError(403, 'Only the author or an admin can delete this note.', 'forbidden');
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
