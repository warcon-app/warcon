// Asks Steam again about this player (persona, account age, bans) and returns the fresh dossier.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap, requireUser } from '$lib/server/access';
import { dossier, requireSteamId } from '$lib/server/players';
import { assertRate } from '$lib/server/ratelimit';

export const POST = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server, access } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'server.view'
	);
	const steamId = requireSteamId(param(event, 'steamId'));
	assertRate(`steam:${user.id}`, 20, 60_000);
	return apiJson({
		ok: true,
		dossier: await dossier(env, user, server, access, steamId, { refreshSteam: true })
	});
});
