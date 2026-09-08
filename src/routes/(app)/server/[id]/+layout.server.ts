import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { getServer } from '$lib/server/access';
import { ACTIONS } from '$lib/server/actions';
import { publicMessage } from '$lib/server/http';
import { WardogsClient } from '$lib/server/rcon';
import type { Catalog, Features, ServerInfo } from '$lib/types';

const EMPTY: Catalog = { maps: [], lightings: [], experiences: [] };

export const load: LayoutServerLoad = async ({ params, parent }) => {
	const env = getEnv();
	// The (app) layout already resolved every server this user may open, with role and org name;
	// the row itself is still needed for the RCON credentials.
	const [{ servers }, row] = await Promise.all([parent(), getServer(env, params.id)]);
	const server: ServerInfo | undefined = servers.find((s) => s.id === params.id);
	if (!server || !row) error(404, 'Server not found, or you have no access to it.');
	let catalog: Catalog = EMPTY;
	let features: Features = { changeTeam: false, configDocument: false };
	let reachable = true;
	let problem = '';
	try {
		const client = await WardogsClient.forServer(env, row);
		catalog = (await ACTIONS.catalog.run(client, {})) as Catalog;
		try {
			features = ((await ACTIONS.capabilities.run(client, {})) as { features: Features }).features;
		} catch {
			/* older plugin builds have no capabilities route */
		}
	} catch (err) {
		reachable = false;
		problem = publicMessage(err);
	}
	return { server, catalog, features, reachable, problem };
};
