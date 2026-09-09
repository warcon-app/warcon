// Steam Web API lookups (persona, avatar, account age, VAC and game bans), cached in the
// steam_profiles table. One key for the whole panel (STEAM_API_KEY); nothing is fetched without it.
import { inArray, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, str } from './http';
import { steamProfiles, type SteamProfileRow } from './db/schema';

export type { SteamProfileRow };

/** Cached rows older than this are refreshed when next asked for. */
export const STEAM_MAX_AGE_MS = 24 * 3600_000;
const CHUNK = 100;
const BACKOFF_MS = 60_000;

export const steamEnabled = (env: Pick<Env, 'STEAM_API_KEY'>): boolean => !!env.STEAM_API_KEY;
export const isSteamId = (v: unknown): v is string => typeof v === 'string' && /^\d{17}$/.test(v);

/** A request value that must be a SteamID64, trimmed; 400 otherwise. */
export function requireSteamId(v: unknown): string {
	const id = str(v, 32);
	if (!isSteamId(id)) throw new ApiError(400, 'steamId must be a 17-digit SteamID64.');
	return id;
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

/**
 * Cached profiles for these ids. With a key configured, missing or stale rows are fetched first;
 * a Steam failure is logged and the cached rows are returned, unless `refresh` was asked for.
 */
export async function getProfiles(
	env: Env,
	ids: string[],
	opts: { refresh?: boolean; maxAgeMs?: number } = {}
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
	if (!stale.length) return map;
	try {
		for (const row of await fetchSteam(env, stale)) map.set(row.steamId, row);
	} catch (err) {
		if (opts.refresh) throw err;
		console.warn('[warcon] steam lookup', err instanceof Error ? err.message : err);
	}
	return map;
}
