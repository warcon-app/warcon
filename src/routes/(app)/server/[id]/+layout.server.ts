import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { getServer, requireUser, serverRoleFor } from '$lib/server/access';
import { ACTIONS } from '$lib/server/actions';
import { WardogsClient, isDemoServer } from '$lib/server/rcon';
import type { Catalog, Features, ServerInfo } from '$lib/types';

const EMPTY: Catalog = { maps: [], lightings: [], experiences: [] };

export const load: LayoutServerLoad = async ({ params, locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	const row = await getServer(env, params.id);
	const role = row ? await serverRoleFor(env, user, params.id) : null;
	if (!row || !role) error(404, 'Server not found, or you have no access to it.');

	const server: ServerInfo = {
		id: row.id,
		name: row.name,
		host: row.host,
		port: row.port,
		scheme: row.scheme,
		notes: row.notes,
		role,
		sortOrder: row.sortOrder,
		demo: isDemoServer(env, row)
	};
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
		problem = err instanceof Error ? err.message : String(err);
	}
	return { server, catalog, features, reachable, problem };
};
