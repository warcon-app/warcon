// The event feed on the database side: each server's feed token, which batch belongs to which
// server, and how every event becomes a row in `kills`. Inbound data from the game process, so it runs
// on the web role and writes Postgres directly; the worker's lane is for requests Warcon makes.
import {
	and,
	count,
	desc,
	eq,
	gt,
	gte,
	lte,
	ilike,
	inArray,
	isNull,
	lt,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { createHash, randomBytes } from 'node:crypto';
import type { Env } from './env';
import { decryptSecret, encryptSecret } from './crypto';
import { ApiError } from './http';
import { writeAudit } from './audit';
import {
	kills,
	matches,
	playerSessions,
	serverLive,
	servers,
	type KillRow,
	type ServerRow
} from './db/schema';
import type { KillView } from '$lib/types';
import { VEHICLE_TAGS, type KillFilter } from '$lib/kills';
import type { SessionUser } from './access';
import { FEED_TOKEN_PREFIX, isTeamKill, parseBatch, type ParsedEvent } from './feed-core';

const hashToken = (token: string): string =>
	createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * What goes in [WDServerFeed] Url: the panel's origin alone. The game appends /api/ingest/events
 * to whatever Url holds (CL-501228), so the route lives at that path.
 */
export const feedUrl = (env: Pick<Env, 'ORIGIN'>): string => env.ORIGIN;

export interface FeedSetup {
	configured: boolean;
	url: string;
	/** the token, for org owners only; '' otherwise */
	token: string;
	feedAt: string | null;
}

export async function feedSetup(env: Env, server: ServerRow, reveal: boolean): Promise<FeedSetup> {
	const [live] = await env.db
		.select({ feedAt: serverLive.feedAt })
		.from(serverLive)
		.where(eq(serverLive.serverId, server.id));
	return {
		configured: !!server.feedTokenHash,
		url: feedUrl(env),
		token: reveal && server.feedTokenEnc ? decryptSecret(env, server.feedTokenEnc) : '',
		feedAt: live?.feedAt ? live.feedAt.toISOString() : null
	};
}

/** A new token for the server (replacing any it had), audited. */
export async function mintFeedToken(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow
): Promise<string> {
	const token = FEED_TOKEN_PREFIX + randomBytes(32).toString('base64url');
	await env.db
		.update(servers)
		.set({ feedTokenEnc: encryptSecret(env, token), feedTokenHash: hashToken(token) })
		.where(eq(servers.id, server.id));
	tokenCache.clear();
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: server.feedTokenHash ? 'feed.rotate' : 'feed.enable',
		outcome: 'ok'
	});
	return token;
}

export async function removeFeedToken(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow
): Promise<void> {
	if (!server.feedTokenHash) throw new ApiError(400, 'This server has no kill feed token.');
	await env.db
		.update(servers)
		.set({ feedTokenEnc: null, feedTokenHash: null })
		.where(eq(servers.id, server.id));
	tokenCache.clear();
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'feed.disable',
		outcome: 'ok'
	});
}

// A busy fleet posts many times a second; the token is looked up once a minute per process.
const TOKEN_TTL_MS = 60_000;
const tokenCache = new Map<string, { serverId: string; until: number }>();

/** The server a feed bearer belongs to, or null. */
export async function resolveFeedToken(env: Env, token: string): Promise<string | null> {
	const hash = hashToken(token);
	const hit = tokenCache.get(hash);
	if (hit && hit.until > Date.now()) return hit.serverId;
	const [row] = await env.db
		.select({ id: servers.id })
		.from(servers)
		.where(eq(servers.feedTokenHash, hash));
	if (!row) return null;
	tokenCache.set(hash, { serverId: row.id, until: Date.now() + TOKEN_TTL_MS });
	return row.id;
}

/** Test-only. */
export const forgetFeedTokens = (): void => tokenCache.clear();

const FEED_AT_EVERY_MS = 10_000;
const feedAtWritten = new Map<string, number>();

/** Dedupe looks only this far back: retries come seconds later, and chunk exclusion keeps it cheap. */
const DEDUPE_WINDOW_MS = 24 * 3600_000;

export interface IngestResult {
	/** all newly stored events, not only kills */
	accepted: number;
	acceptedKills: number;
	skipped: number;
	duplicates: number;
	duplicateKills: number;
	/** what was written, in feed order */
	kills: KillView[];
}

export function killView(r: KillRow): KillView {
	if (r.eventType !== 'killed' || !r.parsedKill || !r.victimSteamId || r.eventTime === null)
		throw new Error('A non-kill feed event reached a kill view.');
	return {
		eventId: r.eventId,
		ts: r.ts.toISOString(),
		map: r.map,
		eventTime: r.eventTime,
		killer: r.killerSteamId
			? { steamId: r.killerSteamId, name: r.killerName ?? '', faction: r.killerFaction }
			: null,
		victim: { steamId: r.victimSteamId, name: r.victimName, faction: r.victimFaction },
		cause: r.cause,
		distanceM: r.distanceM,
		headshot: r.headshot,
		suicide: r.suicide,
		teamKill: r.teamKill,
		tags: Array.isArray(r.tags) ? (r.tags as string[]) : []
	};
}

/**
 * Writes one batch: parse, drop what is already stored, add the open match and both factions
 * from the sessions the worker keeps, insert. `now` is the receipt time.
 */
export async function ingestBatch(
	env: Env,
	serverId: string,
	body: unknown,
	now = new Date()
): Promise<IngestResult> {
	let batch;
	try {
		batch = parseBatch(body);
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'Malformed batch.');
	}
	let fresh: ParsedEvent[] = batch.events;
	let duplicates = 0;
	let duplicateKills = 0;
	let written: KillView[] = [];
	if (fresh.length)
		// The table cannot hold a unique event id (a hypertable's unique indexes must include ts),
		// so the look and the insert are one turn per server: the game sends a batch again when it
		// did not hear back, and a copy that arrived mid-write passed the look and was written too.
		await env.db.transaction(async (db) => {
			await db.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${'feed:' + serverId}, 0))`
			);
			const ids = [...new Set(fresh.map((k) => k.eventId))];
			const seen = new Set(
				(
					await db
						.select({ eventId: kills.eventId })
						.from(kills)
						.where(
							and(
								eq(kills.serverId, serverId),
								inArray(kills.eventId, ids),
								gt(kills.ts, new Date(now.getTime() - DEDUPE_WINDOW_MS))
							)
						)
				).map((r) => r.eventId)
			);
			const once = new Set<string>();
			fresh = fresh.filter((k) => {
				if (seen.has(k.eventId) || once.has(k.eventId)) return false;
				once.add(k.eventId);
				return true;
			});
			duplicates = batch.events.length - fresh.length;
			duplicateKills = batch.kills.length - fresh.filter((e) => e.kill !== null).length;
			if (!fresh.length) return;
			const steamIds = [
				...new Set(
					fresh.flatMap(({ kill }) =>
						kill
							? kill.killerSteamId
								? [kill.killerSteamId, kill.victimSteamId]
								: [kill.victimSteamId]
							: []
					)
				)
			];
			const [open, [match]] = await Promise.all([
				db
					.select({ steamId: playerSessions.steamId, faction: playerSessions.faction })
					.from(playerSessions)
					.where(
						and(
							eq(playerSessions.serverId, serverId),
							isNull(playerSessions.leftAt),
							inArray(playerSessions.steamId, steamIds)
						)
					)
					.orderBy(playerSessions.id),
				db
					.select({ id: matches.id })
					.from(matches)
					.where(and(eq(matches.serverId, serverId), isNull(matches.endedAt)))
					.orderBy(sql`${matches.id} DESC`)
					.limit(1)
			]);
			// Newest open session wins when a player somehow has two.
			const faction = new Map<string, string | null>();
			for (const s of open) faction.set(s.steamId, s.faction);
			const rows = await db
				.insert(kills)
				.values(
					fresh.map((event) => {
						const k = event.kill;
						const kf = k?.killerSteamId ? (faction.get(k.killerSteamId) ?? null) : null;
						const vf = k ? (faction.get(k.victimSteamId) ?? null) : null;
						return {
							ts: now,
							serverId,
							eventId: event.eventId,
							eventType: event.eventType,
							parsedKill: k !== null,
							rawEvent: event.raw,
							instanceId: batch.instanceId,
							matchId: event.matchId,
							matchRow: match?.id ?? null,
							eventTime: event.eventTime,
							map: event.map,
							killerSteamId: k?.killerSteamId ?? null,
							killerName: k?.killerName ?? null,
							killerFaction: kf,
							victimSteamId: k?.victimSteamId ?? null,
							victimName: k?.victimName ?? '',
							victimFaction: vf,
							cause: k?.cause ?? null,
							distanceM: k?.distanceM ?? null,
							headshot: k?.headshot ?? false,
							suicide: k?.suicide ?? false,
							teamKill: k ? isTeamKill(k, kf, vf) : false,
							tags: k?.tags ?? []
						};
					})
				)
				.returning();
			written = rows.filter((r) => r.eventType === 'killed' && r.parsedKill).map(killView);
		});
	// The liveness stamp, at most every ten seconds per server: the worker's upsert of the row
	// leaves this column alone, so the two never fight.
	const last = feedAtWritten.get(serverId) ?? 0;
	if (now.getTime() - last >= FEED_AT_EVERY_MS) {
		feedAtWritten.set(serverId, now.getTime());
		await env.db
			.insert(serverLive)
			.values({ serverId, feedAt: now })
			.onConflictDoUpdate({ target: serverLive.serverId, set: { feedAt: now } });
	}
	return {
		accepted: fresh.length,
		acceptedKills: written.length,
		skipped: batch.skipped,
		duplicates,
		duplicateKills,
		kills: written
	};
}

const STEAM_RE = /^\d{17}$/;
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** One side of a kill: a SteamID exactly, else part of the name. Mirrors sideMatches in $lib/kills. */
const sideIs = (needle: string, steamId: AnyPgColumn, name: AnyPgColumn) =>
	STEAM_RE.test(needle) ? eq(steamId, needle) : ilike(name, `%${likeEscape(needle)}%`);

/** A page boundary: the last row shown, as (ts, eventTime); eventTime null means ts alone. */
export interface KillsBefore {
	ts: Date;
	eventTime: number | null;
}

/** One match's kills: the rows carrying its match row, within its window on (server_id, ts). */
export interface KillsOfMatch {
	matchRow: number;
	from: Date;
	to: Date | null;
}

/** The rows of one server the filter asks for, older than `before` when given, of one match when given. */
function killWhere(
	serverId: string,
	before: KillsBefore | null,
	f: KillFilter,
	match: KillsOfMatch | null = null
): SQL {
	const conds: (SQL | undefined)[] = [
		eq(kills.serverId, serverId),
		eq(kills.eventType, 'killed'),
		eq(kills.parsedKill, true)
	];
	if (match) {
		conds.push(eq(kills.matchRow, match.matchRow), gte(kills.ts, match.from));
		if (match.to) conds.push(lte(kills.ts, match.to));
	}
	// A batch's kills share a receipt time, so a page boundary is the pair the feed sorts by.
	if (before)
		conds.push(
			before.eventTime === null
				? lt(kills.ts, before.ts)
				: sql`(${kills.ts}, ${kills.eventTime}) < (${before.ts}, ${before.eventTime})`
		);
	if (f.killer) conds.push(sideIs(f.killer, kills.killerSteamId, kills.killerName));
	if (f.victim) conds.push(sideIs(f.victim, kills.victimSteamId, kills.victimName));
	if (f.player)
		conds.push(
			or(
				sideIs(f.player, kills.killerSteamId, kills.killerName),
				sideIs(f.player, kills.victimSteamId, kills.victimName)
			)
		);
	if (f.cause) conds.push(eq(kills.cause, f.cause));
	if (f.minM !== null) conds.push(gte(kills.distanceM, f.minM));
	switch (f.kind) {
		case 'headshot':
			conds.push(eq(kills.headshot, true));
			break;
		case 'teamKill':
			conds.push(eq(kills.teamKill, true));
			break;
		case 'suicide':
			conds.push(eq(kills.suicide, true));
			break;
		case 'environment':
			conds.push(isNull(kills.killerSteamId));
			break;
		case 'vehicle':
			conds.push(
				or(
					ilike(kills.cause, 'Vehicle.%'),
					ilike(kills.cause, 'Id.Vehicle.%'),
					sql`${kills.tags} ?| ${sql.raw(`ARRAY[${VEHICLE_TAGS.map((t) => `'${t}'`).join(',')}]`)}`
				)
			);
			break;
	}
	return and(...conds)!;
}

/** The newest `limit` kills on a server the filter asks for, older than `before` when given. */
export async function recentKills(
	env: Env,
	serverId: string,
	before: KillsBefore | null,
	limit: number,
	filter: KillFilter,
	match: KillsOfMatch | null = null
): Promise<KillView[]> {
	const rows = await env.db
		.select()
		.from(kills)
		.where(killWhere(serverId, before, filter, match))
		.orderBy(desc(kills.ts), desc(kills.eventTime))
		.limit(limit);
	return rows.map(killView);
}

/** How many kills on the server the filter asks for, over the whole history. */
export async function countKills(
	env: Env,
	serverId: string,
	filter: KillFilter,
	match: KillsOfMatch | null = null
): Promise<number> {
	const [row] = await env.db
		.select({ n: count() })
		.from(kills)
		.where(killWhere(serverId, null, filter, match));
	return row?.n ?? 0;
}
