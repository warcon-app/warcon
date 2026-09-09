// The player dossier: history across the org's servers, Steam data, risk, notes, watchlist.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerRole, requireUser } from '$lib/server/access';
import { dossier, requireSteamId } from '$lib/server/players';

export const GET = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server, role } = await requireServerRole(env, event.locals, param(event, 'id'), 'viewer');
	const steamId = requireSteamId(param(event, 'steamId'));
	return apiJson({ ok: true, dossier: await dossier(env, user, server, role, steamId) });
});
