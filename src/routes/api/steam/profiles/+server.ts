// Optional Steam persona lookup, same contract as rcon.wardogs.com's /api/steam/profiles:
// GET /api/steam/profiles?ids=a,b,c -> { "<id>": { name, avatar } | null }
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, route } from '$lib/server/http';
import { requireUser } from '$lib/server/access';

const cache = new Map<string, { body: unknown; until: number }>();

export const GET = route(async ({ locals, url }) => {
	const env = getEnv();
	requireUser(locals);
	const key = env.STEAM_API_KEY;
	if (!key)
		throw new ApiError(
			404,
			'Steam lookup is not configured (set STEAM_API_KEY in .env).',
			'steam_disabled'
		);
	const ids = [
		...new Set(
			(url.searchParams.get('ids') || '')
				.split(',')
				.map((s) => s.trim())
				.filter((s) => /^\d{17}$/.test(s))
		)
	].slice(0, 100);
	const out: Record<string, { name: string; avatar: string } | null> = {};
	if (!ids.length) return apiJson(out);
	const cacheKey = ids.join(',');
	const hit = cache.get(cacheKey);
	if (hit && hit.until > Date.now())
		return apiJson(hit.body, 200, { 'cache-control': 'public, max-age=3600' });
	const api = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${ids.join(',')}`;
	const res = await fetch(api, { signal: AbortSignal.timeout(8000) });
	if (res.status === 401 || res.status === 403)
		throw new ApiError(502, 'Steam refused the configured API key.');
	if (!res.ok) throw new ApiError(502, `Steam answered ${res.status}.`);
	const data = (await res.json().catch(() => ({}))) as {
		response?: {
			players?: { steamid: string; personaname?: string; avatarmedium?: string; avatar?: string }[];
		};
	};
	for (const id of ids) out[id] = null;
	for (const p of data?.response?.players || [])
		out[p.steamid] = { name: p.personaname || '', avatar: p.avatarmedium || p.avatar || '' };
	cache.set(cacheKey, { body: out, until: Date.now() + 60 * 60 * 1000 });
	if (cache.size > 500) cache.delete(cache.keys().next().value!);
	return apiJson(out, 200, { 'cache-control': 'public, max-age=3600' });
});
