import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireServerCap, requireUser } from '$lib/server/access';
import { requireSteamId, setWatch } from '$lib/server/players';

/** {watched, reason}: put a player on the org's watchlist or take them off. */
export const PUT = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'players.notes');
	const steamId = requireSteamId(param(event, 'steamId'));
	const body = await readJson(event.request);
	await setWatch(env, event.request, user, server, steamId, !!body.watched, body.reason);
	return apiJson({ ok: true });
});
