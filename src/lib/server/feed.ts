// The kill feed on the database side: each server's feed token, which batch belongs to which
// server, and how a batch becomes rows in `kills`. Inbound data from the game process, so it runs
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
import { isDemoServer, type Env } from './env';
import { decryptSecret, encryptSecret } from './crypto';
import { ApiError } from './http';
import { writeAudit } from './audit';
import {
	kills,
	matchEvents,
	matches,
	playerSessions,
	serverLive,
	servers,
	type KillRow,
	type ServerRow
} from './db/schema';
import type { KillView, MatchStateView } from '$lib/types';
import { feedHealth, type FeedState } from '$lib/feed-health';
import { VEHICLE_TAGS, type KillFilter } from '$lib/kills';
import type { SessionUser } from './access';
import {
	FEED_TOKEN_PREFIX,
	isTeamKill,
	parseBatch,
	type ParsedEnd,
	type ParsedKill,
	type ParsedState
} from './feed-core';

const hashToken = (token: string): string =>
	createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * What goes in [WDServerFeed] Url: the panel's origin alone. Builds up to CL-509546 append
 * /api/ingest/events to whatever Url holds (CL-501228), so the route lives at that path. Season 2's
 * EventFeedEndpoints Url is posted to as written and carries the path ($lib/feed-setup).
 */
export const feedUrl = (env: Pick<Env, 'ORIGIN'>): string => env.ORIGIN;

/** Whether the server's kill feed reaches the panel, with what the verdict was drawn from. */
export interface FeedStatus {
	configured: boolean;
	/** when the last batch arrived */
	feedAt: string | null;
	/** when the game process last started, as the worker last read it */
	startedAt: string | null;
	/** when the token was made, beside the token itself (org owners); null otherwise */
	tokenAt: string | null;
	/** $lib/feed-health; 'waiting' only where the token's time is known */
	state: FeedState;
}

export interface FeedSetup extends FeedStatus {
	url: string;
	/** the token, for org owners only; '' otherwise */
	token: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * The feed's verdict from the server's live row. `withTokenTime` is for those who may see the token:
 * when it was replaced is part of how the server is run, so only they are told it is waiting for
 * the game's restart (everyone else reads it as silent, which it is).
 */
export async function feedStatus(
	env: Env,
	server: ServerRow,
	withTokenTime: boolean
): Promise<FeedStatus> {
	const [live] = await env.db
		.select({
			feedAt: serverLive.feedAt,
			ok: serverLive.ok,
			startedAt: serverLive.startedAt,
			observedAt: serverLive.observedAt
		})
		.from(serverLive)
		.where(eq(serverLive.serverId, server.id));
	const configured = !!server.feedTokenHash;
	const feedAt = iso(live?.feedAt);
	const startedAt = iso(live?.startedAt);
	// The demo game takes its token at once (feedDemoKills), with no restart to wait for.
	const tokenAt =
		withTokenTime && configured && !isDemoServer(env, server) ? iso(server.feedTokenAt) : null;
	const state = feedHealth({
		configured,
		feedAt,
		tokenAt,
		live: live ? { ok: live.ok, startedAt, observedAt: iso(live.observedAt) } : null
	});
	return { configured, feedAt, startedAt, tokenAt, state };
}

export async function feedSetup(env: Env, server: ServerRow, reveal: boolean): Promise<FeedSetup> {
	return {
		...(await feedStatus(env, server, reveal)),
		url: feedUrl(env),
		token: reveal && server.feedTokenEnc ? decryptSecret(env, server.feedTokenEnc) : ''
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
		.set({
			feedTokenEnc: encryptSecret(env, token),
			feedTokenHash: hashToken(token),
			feedTokenAt: new Date()
		})
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
		.set({ feedTokenEnc: null, feedTokenHash: null, feedTokenAt: null })
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

/**
 * The last match state this process stored for each server, as `instance|state|match`: one the
 * same is a repeat, counted and not stored (whether the game repeats its state is not known).
 * Another web process, or this one after a restart, stores it once more.
 */
const storedState = new Map<string, string>();
const stateKey = (instanceId: string, s: ParsedState) => `${instanceId}|${s.state}|${s.matchId}`;

/** The events not stored yet, each once. */
function unseen<T extends { eventId: string }>(events: T[], seen: Set<string>): T[] {
	const once = new Set<string>();
	return events.filter((e) => {
		if (seen.has(e.eventId) || once.has(e.eventId)) return false;
		once.add(e.eventId);
		return true;
	});
}

export interface IngestResult {
	accepted: number;
	/** joins, leaves, match states and results: known events other than kills */
	other: number;
	skipped: number;
	/** kills, match states and results already stored: the game sent the batch again */
	duplicates: number;
	/** match states the same as the last one stored for the server, not stored again */
	repeats: number;
	/** what was written, in feed order */
	kills: KillView[];
	/** the batch's last match state stored, as written to server_live; null when none was */
	state: MatchStateView | null;
	/** the batch's last match result stored; null when none was */
	end: ParsedEnd | null;
}

export function killView(r: KillRow): KillView {
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
	let fresh: ParsedKill[] = batch.kills;
	let states: ParsedState[] = [];
	let ends: ParsedEnd[] = [];
	let duplicates = 0;
	let repeats = 0;
	let written: KillView[] = [];
	let lastState = storedState.get(serverId);
	if (batch.kills.length || batch.states.length || batch.ends.length)
		// The tables cannot hold a unique event id (a hypertable's unique indexes must include ts),
		// so the look and the insert are one turn per server: the game sends a batch again when it
		// did not hear back, and a copy that arrived mid-write passed the look and was written too.
		await env.db.transaction(async (db) => {
			await db.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${'feed:' + serverId}, 0))`
			);
			const since = new Date(now.getTime() - DEDUPE_WINDOW_MS);
			const killIds = [...new Set(batch.kills.map((k) => k.eventId))];
			const eventIds = [...new Set([...batch.states, ...batch.ends].map((e) => e.eventId))];
			const [seenKills, seenEvents] = await Promise.all([
				killIds.length
					? db
							.select({ eventId: kills.eventId })
							.from(kills)
							.where(
								and(
									eq(kills.serverId, serverId),
									inArray(kills.eventId, killIds),
									gt(kills.ts, since)
								)
							)
					: [],
				eventIds.length
					? db
							.select({ eventId: matchEvents.eventId })
							.from(matchEvents)
							.where(
								and(
									eq(matchEvents.serverId, serverId),
									inArray(matchEvents.eventId, eventIds),
									gt(matchEvents.ts, since)
								)
							)
					: []
			]);
			fresh = unseen(batch.kills, new Set(seenKills.map((r) => r.eventId)));
			const seen = new Set(seenEvents.map((r) => r.eventId));
			const newStates = unseen(batch.states, seen);
			ends = unseen(batch.ends, seen);
			duplicates =
				batch.kills.length -
				fresh.length +
				batch.states.length -
				newStates.length +
				batch.ends.length -
				ends.length;
			let key = storedState.get(serverId);
			states = newStates.filter((st) => {
				const k = stateKey(batch.instanceId, st);
				if (k === key) return false;
				key = k;
				return true;
			});
			repeats = newStates.length - states.length;
			lastState = key;
			if (states.length || ends.length)
				await db.insert(matchEvents).values([
					...states.map((st) => ({
						ts: now,
						serverId,
						eventId: st.eventId,
						seq: st.seq,
						instanceId: batch.instanceId,
						type: 'match_state',
						eventTime: st.eventTime,
						matchId: st.matchId || null,
						map: st.map,
						state: st.state
					})),
					...ends.map((e) => ({
						ts: now,
						serverId,
						eventId: e.eventId,
						seq: e.seq,
						instanceId: batch.instanceId,
						type: 'match_ended',
						eventTime: e.eventTime,
						matchId: e.matchId || null,
						map: e.map,
						players: e.players,
						winningFaction: e.winningFaction,
						scores: e.scores
					}))
				]);
			if (!fresh.length) return;
			const steamIds = [
				...new Set(
					fresh.flatMap((k) =>
						k.killerSteamId ? [k.killerSteamId, k.victimSteamId] : [k.victimSteamId]
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
					fresh.map((k) => {
						const kf = k.killerSteamId ? (faction.get(k.killerSteamId) ?? null) : null;
						const vf = faction.get(k.victimSteamId) ?? null;
						return {
							ts: now,
							serverId,
							eventId: k.eventId,
							instanceId: batch.instanceId,
							matchId: k.matchId,
							matchRow: match?.id ?? null,
							eventTime: k.eventTime,
							map: k.map,
							killerSteamId: k.killerSteamId,
							killerName: k.killerName,
							killerFaction: kf,
							victimSteamId: k.victimSteamId,
							victimName: k.victimName,
							victimFaction: vf,
							cause: k.cause,
							distanceM: k.distanceM,
							headshot: k.headshot,
							suicide: k.suicide,
							teamKill: isTeamKill(k, kf, vf),
							tags: k.tags
						};
					})
				)
				.returning();
			written = rows.map(killView);
		});
	// Only once it is committed: a batch that failed is sent again, and its state is no repeat.
	if (lastState !== undefined) storedState.set(serverId, lastState);
	// The liveness stamp, at most every ten seconds per server, and the match state whenever it
	// moves (a few times a match): the worker's upsert of the row leaves both columns alone, so the
	// two never fight.
	const last = states.at(-1);
	const state: MatchStateView | null = last
		? { state: last.state, map: last.map, at: now.toISOString() }
		: null;
	if (state || now.getTime() - (feedAtWritten.get(serverId) ?? 0) >= FEED_AT_EVERY_MS) {
		feedAtWritten.set(serverId, now.getTime());
		const set = state ? { feedAt: now, matchState: state } : { feedAt: now };
		await env.db
			.insert(serverLive)
			.values({ serverId, ...set })
			.onConflictDoUpdate({ target: serverLive.serverId, set });
	}
	return {
		accepted: fresh.length,
		other: batch.other,
		skipped: batch.skipped,
		duplicates,
		repeats,
		kills: written,
		state,
		end: ends.at(-1) ?? null
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
	const conds: (SQL | undefined)[] = [eq(kills.serverId, serverId)];
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
	if (f.cause) conds.push(sql`lower(${kills.cause}) = lower(${f.cause})`);
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
		// ts DESC NULLS LAST, as kills_server_ts_idx is built (Drizzle writes .desc() so): plain DESC
		// cannot use it, and the planner then walked every server's kills newest first through the
		// ts index looking for this server's, up to the whole table for a quiet one (the hosted
		// panel's costliest statement, 2026-10-04).
		.orderBy(sql`${kills.ts} desc nulls last`, desc(kills.eventTime))
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
