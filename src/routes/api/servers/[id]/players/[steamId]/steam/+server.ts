// Asks Steam again about this player (persona, account age, bans) and returns the fresh dossier.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerRole, requireUser } from '$lib/server/access';
import { dossier, requireSteamId } from '$lib/server/players';
import { assertRate } from '$lib/server/ratelimit';

export const POST = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server, role } = await requireServerRole(env, event.locals, param(event, 'id'), 'viewer');
	const steamId = requireSteamId(param(event, 'steamId'));
	assertRate(`steam:${user.id}`, 20, 60_000);
	return apiJson({
		ok: true,
		dossier: await dossier(env, user, server, role, steamId, { refreshSteam: true })
	});
});
