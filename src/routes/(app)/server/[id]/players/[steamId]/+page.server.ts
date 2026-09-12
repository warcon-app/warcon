import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { getServer, requireUser } from '$lib/server/access';
import { dossier } from '$lib/server/players';
import { accessFromCaps } from '$lib/server/access-resolve';

export const load: PageServerLoad = async ({ locals, params, parent }) => {
	const env = getEnv();
	const user = requireUser(locals);
	// The server layout already refused anyone without access to this server.
	const [{ server }, row] = await Promise.all([parent(), getServer(env, params.id)]);
	if (!row) error(404, 'Server not found.');
	if (!/^\d{17}$/.test(params.steamId)) error(404, 'Not a SteamID64.');
	return {
		dossier: await dossier(
			env,
			user,
			row,
			accessFromCaps(server.caps, server.roleName),
			params.steamId
		)
	};
};
