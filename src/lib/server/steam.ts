// Steam Web API lookups (persona, avatar, account age, VAC and game bans), cached in the
// steam_profiles table. One key for the whole panel (STEAM_API_KEY); nothing is fetched without it.
import { eq, inArray, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, forLog, str } from './http';
import { steamProfiles, type SteamProfileRow } from './db/schema';

export type { SteamProfileRow };

/** Cached rows older than this are refreshed when next asked for. */
export const STEAM_MAX_AGE_MS = 24 * 3600_000;
const CHUNK = 100;
const BACKOFF_MS = 60_000;
const FRIEND_LIMIT = 200;
const FRIEND_WORKERS = 8;
const FRIEND_UNKNOWN_RETRY_MS = 3600_000;
/** a friends list moves slowly, and each look costs up to three calls that cannot be batched */
const FRIEND_MAX_AGE_MS = 7 * 24 * 3600_000;
/**
 * The most friends-list calls in a day. Steam allows a key 100,000 calls a day, and the profile
 * and ban lookups the kick rules depend on come first.
 */
const FRIEND_DAILY_CALLS = 20_000;
let friendDay = 0;
let friendCalls = 0;
const friendBudget = (calls: number): boolean => {
	const day = Math.floor(Date.now() / (24 * 3600_000));
	if (day !== friendDay) [friendDay, friendCalls] = [day, 0];
	if (friendCalls + calls > FRIEND_DAILY_CALLS) return false;
	friendCalls += calls;
	return true;
};
const friendInFlight = new Set<string>();

const friendsStale = (row: SteamProfileRow, now: number): boolean =>
	!row.friendsCheckedAt ||
	now - row.friendsCheckedAt.getTime() >=
		(row.friendsState === 'unknown' ? FRIEND_UNKNOWN_RETRY_MS : FRIEND_MAX_AGE_MS);

export const steamEnabled = (env: Pick<Env, 'STEAM_API_KEY'>): boolean => !!env.STEAM_API_KEY;
export const isSteamId = (v: unknown): v is string => typeof v === 'string' && /^\d{17}$/.test(v);

/**
 * A request value that must be a SteamID64, trimmed; 400 otherwise. Only a string will do: a JSON
 * number that long arrives rounded (76561198100000101 parses as 76561198100000100), still 17
 * digits, and would name another player.
 */
export function requireSteamId(v: unknown): string {
	const id = typeof v === 'string' ? str(v, 32) : '';
	if (!isSteamId(id)) throw new ApiError(400, steamIdRefusal(v));
	return id;
}

/** Why a value was not taken as a SteamID64. */
export const steamIdRefusal = (v: unknown): string =>
	typeof v === 'number'
		? 'steamId must be sent as a string: a number that long loses its last digits.'
		: 'steamId must be a 17-digit SteamID64.';

/**
 * A rule's players it leaves alone, as SteamID64s: trimmed, blanks dropped, each once; absent is
 * none, anything but a list is a 400. Strings only, for the reason requireSteamId gives.
 */
export function steamIdList(v: unknown, max: number): string[] {
	if (v === undefined) return [];
	if (!Array.isArray(v)) throw new ApiError(400, 'exempt must be a list of SteamID64s.');
	const ids = new Set<string>();
	for (const item of v) {
		if (typeof item === 'number')
			throw new ApiError(
				400,
				'SteamIDs must be sent as strings: a number that long loses its last digits.'
			);
		const id = str(item, 32);
		if (!id) continue;
		if (!isSteamId(id))
			throw new ApiError(400, `"${str(item, 20)}" is not a SteamID64 (17 digits).`);
		ids.add(id);
	}
	if (ids.size > max) throw new ApiError(400, `At most ${max} players can be left alone.`);
	return [...ids];
}

/** After Steam answers 429 or 5xx, nothing is asked again until this passes. */
let backoffUntil = 0;

interface SummaryJson {
	steamid: string;
	personaname?: string;
	avatarmedium?: string;
	avatar?: string;
	profileurl?: string;
	timecreated?: number;
	communityvisibilitystate?: number;
}
interface BanJson {
	SteamId: string;
	CommunityBanned?: boolean;
	VACBanned?: boolean;
	NumberOfVACBans?: number;
	DaysSinceLastBan?: number;
	NumberOfGameBans?: number;
	EconomyBan?: string;
}

type FriendState = 'unknown' | 'public' | 'private' | 'partial';
interface FriendEvidence {
	state: FriendState;
	total: number;
	checked: number;
	banned: number;
}

/** A private friends list is a documented 401, not a broken Steam key. Other failures are unknown. */
async function friendEvidence(key: string, steamId: string): Promise<FriendEvidence> {
	const unknown: FriendEvidence = { state: 'unknown', total: 0, checked: 0, banned: 0 };
	if (Date.now() < backoffUntil) return unknown;
	try {
		const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${encodeURIComponent(key)}&steamid=${steamId}&relationship=friend`;
		const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (response.status === 401) return { ...unknown, state: 'private' };
		if (response.status === 429 || response.status >= 500) backoffUntil = Date.now() + BACKOFF_MS;
		if (!response.ok) return unknown;
		const body = (await response.json()) as {
			friendslist?: { friends?: { steamid: string }[] };
		};
		if (!body.friendslist) return unknown;
		const friends = [
			...new Set((body.friendslist.friends ?? []).map((f) => f.steamid).filter(isSteamId))
		];
		const sample = friends.slice(0, FRIEND_LIMIT);
		let banned = 0;
		for (let i = 0; i < sample.length; i += CHUNK) {
			const bans = await steamGet<{ players?: BanJson[] }>(
				'ISteamUser/GetPlayerBans/v1/',
				key,
				sample.slice(i, i + CHUNK)
			);
			banned += (bans.players ?? []).filter(
				(p) => (p.NumberOfVACBans ?? 0) > 0 || (p.NumberOfGameBans ?? 0) > 0
			).length;
		}
		return {
			state: sample.length < friends.length ? 'partial' : 'public',
			total: friends.length,
			checked: sample.length,
			banned
		};
	} catch {
		return unknown;
	}
}

async function refreshFriendEvidence(
	env: Env,
	rows: SteamProfileRow[]
): Promise<SteamProfileRow[]> {
	const out = [...rows];
	const todo = rows
		.map((row, i) => ({ row, i }))
		.filter(
			({ row }) => !row.error && !friendInFlight.has(row.steamId) && friendsStale(row, Date.now())
		);
	for (const { row } of todo) friendInFlight.add(row.steamId);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(FRIEND_WORKERS, todo.length) }, async () => {
			while (next < todo.length) {
				const { row, i } = todo[next++];
				try {
					// Out of budget: left as it is, without a write, for a later day.
					if (!friendBudget(1 + FRIEND_LIMIT / CHUNK)) continue;
					const evidence = await friendEvidence(env.STEAM_API_KEY!, row.steamId);
					if (evidence.state === 'unknown') {
						if (row.friendsState === 'unknown')
							await env.db
								.update(steamProfiles)
								.set({ friendsCheckedAt: new Date() })
								.where(eq(steamProfiles.steamId, row.steamId));
						continue;
					}
					const [updated] = await env.db
						.update(steamProfiles)
						.set({
							friendsState: evidence.state,
							friendsTotal: evidence.total,
							friendsChecked: evidence.checked,
							bannedFriends: evidence.banned,
							friendsCheckedAt: new Date()
						})
						.where(eq(steamProfiles.steamId, row.steamId))
						.returning();
					if (updated) out[i] = updated;
				} catch (err) {
					console.warn('[warcon] Steam friends cache', forLog(err));
				} finally {
					friendInFlight.delete(row.steamId);
				}
			}
		})
	);
	return out;
}

async function steamGet<T>(path: string, key: string, ids: string[]): Promise<T> {
	const url = `https://api.steampowered.com/${path}?key=${encodeURIComponent(key)}&steamids=${ids.join(',')}`;
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(8000) });
	} catch {
		backoffUntil = Date.now() + BACKOFF_MS;
		throw new ApiError(502, 'Steam did not answer.', 'steam_unreachable');
	}
	if (res.status === 401 || res.status === 403)
		throw new ApiError(502, 'Steam refused the configured API key.', 'steam_key');
	if (res.status === 429 || res.status >= 500) {
		backoffUntil = Date.now() + BACKOFF_MS;
		throw new ApiError(502, `Steam answered ${res.status}.`, 'steam_error');
	}
	if (!res.ok) throw new ApiError(502, `Steam answered ${res.status}.`, 'steam_error');
	return (await res.json().catch(() => ({}))) as T;
}

/** Asks Steam about these ids (both endpoints), stores the answers and returns the rows. */
export async function fetchSteam(env: Env, ids: string[]): Promise<SteamProfileRow[]> {
	const key = env.STEAM_API_KEY;
	if (!key)
		throw new ApiError(
			404,
			'Steam lookup is not configured (set STEAM_API_KEY in .env).',
			'steam_disabled'
		);
	if (Date.now() < backoffUntil)
		throw new ApiError(503, 'Steam is rate limiting lookups; try again shortly.', 'steam_backoff');
	const out: SteamProfileRow[] = [];
	const unique = [...new Set(ids.filter(isSteamId))];
	for (let i = 0; i < unique.length; i += CHUNK) {
		const chunk = unique.slice(i, i + CHUNK);
		const [summaries, bans] = await Promise.all([
			steamGet<{ response?: { players?: SummaryJson[] } }>(
				'ISteamUser/GetPlayerSummaries/v2/',
				key,
				chunk
			),
			steamGet<{ players?: BanJson[] }>('ISteamUser/GetPlayerBans/v1/', key, chunk)
		]);
		const byId = new Map((summaries.response?.players || []).map((p) => [p.steamid, p]));
		const banById = new Map((bans.players || []).map((b) => [b.SteamId, b]));
		const now = new Date();
		const rows: (typeof steamProfiles.$inferInsert)[] = chunk.map((steamId) => {
			const s = byId.get(steamId);
			const b = banById.get(steamId);
			return {
				steamId,
				persona: s?.personaname || '',
				avatar: s?.avatarmedium || s?.avatar || '',
				profileUrl: s?.profileurl || '',
				public: s?.communityvisibilitystate === 3,
				accountCreatedAt: s?.timecreated ? new Date(s.timecreated * 1000) : null,
				vacBans: b?.NumberOfVACBans ?? 0,
				gameBans: b?.NumberOfGameBans ?? 0,
				daysSinceLastBan:
					b && (b.NumberOfVACBans || b.NumberOfGameBans) ? (b.DaysSinceLastBan ?? null) : null,
				communityBanned: !!b?.CommunityBanned,
				economyBan: b?.EconomyBan || 'none',
				fetchedAt: now,
				error: s ? '' : 'Not found on Steam.'
			};
		});
		const saved = await env.db
			.insert(steamProfiles)
			.values(rows)
			.onConflictDoUpdate({
				target: steamProfiles.steamId,
				set: {
					persona: sql`excluded.persona`,
					avatar: sql`excluded.avatar`,
					profileUrl: sql`excluded.profile_url`,
					public: sql`excluded.public`,
					accountCreatedAt: sql`excluded.account_created_at`,
					vacBans: sql`excluded.vac_bans`,
					gameBans: sql`excluded.game_bans`,
					daysSinceLastBan: sql`excluded.days_since_last_ban`,
					communityBanned: sql`excluded.community_banned`,
					economyBan: sql`excluded.economy_ban`,
					fetchedAt: sql`excluded.fetched_at`,
					error: sql`excluded.error`
				}
			})
			.returning();
		out.push(...saved);
	}
	return out;
}

/** What the cache holds for these ids, and nothing more: never a request to Steam (public pages). */
export async function cachedProfiles(
	env: Env,
	ids: string[]
): Promise<Map<string, SteamProfileRow>> {
	const unique = [...new Set(ids.filter(isSteamId))];
	const map = new Map<string, SteamProfileRow>();
	if (!unique.length) return map;
	const rows = await env.db
		.select()
		.from(steamProfiles)
		.where(inArray(steamProfiles.steamId, unique));
	for (const row of rows) map.set(row.steamId, row);
	return map;
}

/**
 * Cached profiles for these ids. With a key configured, missing or stale rows are fetched first;
 * a Steam failure is logged and the cached rows are returned, unless `refresh` was asked for.
 */
export async function getProfiles(
	env: Env,
	ids: string[],
	opts: { refresh?: boolean; maxAgeMs?: number; awaitFriends?: boolean } = {}
): Promise<Map<string, SteamProfileRow>> {
	const unique = [...new Set(ids.filter(isSteamId))];
	const map = new Map<string, SteamProfileRow>();
	if (!unique.length) return map;
	const cached = await env.db
		.select()
		.from(steamProfiles)
		.where(inArray(steamProfiles.steamId, unique));
	for (const row of cached) map.set(row.steamId, row);
	if (!steamEnabled(env)) {
		if (opts.refresh)
			throw new ApiError(
				404,
				'Steam lookup is not configured (set STEAM_API_KEY in .env).',
				'steam_disabled'
			);
		return map;
	}
	const maxAge = opts.maxAgeMs ?? STEAM_MAX_AGE_MS;
	const cutoff = Date.now() - maxAge;
	const stale = unique.filter((id) => {
		const row = map.get(id);
		return opts.refresh || !row || row.fetchedAt.getTime() < cutoff;
	});
	if (stale.length)
		try {
			for (const row of await fetchSteam(env, stale)) map.set(row.steamId, row);
		} catch (err) {
			if (opts.refresh) throw err;
			console.warn('[warcon] steam lookup', forLog(err));
		}
	// The friends lists are looked at behind the answer, so nothing that reads a profile waits on
	// a call per player; only a refresh someone asked for waits for them.
	const rows = [...map.values()];
	if (opts.awaitFriends)
		for (const row of await refreshFriendEvidence(env, rows)) map.set(row.steamId, row);
	else void refreshFriendEvidence(env, rows).catch(() => {});
	return map;
}
