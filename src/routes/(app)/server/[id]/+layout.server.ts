import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { getServer } from '$lib/server/access';
import { publicMessage } from '$lib/server/http';
import { gateway } from '$lib/server/gateway';
import type { Catalog, Features, ServerInfo } from '$lib/types';

const EMPTY: Catalog = { maps: [], lightings: [], experiences: [] };
/** Catalog and capabilities change with plugin builds, not with matches: one read per server per hour. */
const CATALOG_TTL_MS = 3600_000;
const catalogs = new Map<string, { until: number; catalog: Catalog; features: Features }>();

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
	const hit = catalogs.get(row.id);
	if (hit && hit.until > Date.now()) {
		catalog = hit.catalog;
		features = hit.features;
	} else {
		try {
			catalog = (await gateway().run(env, row, 'catalog', {})) as Catalog;
			try {
				features = ((await gateway().run(env, row, 'capabilities', {})) as { features: Features })
					.features;
			} catch {
				/* older plugin builds have no capabilities route */
			}
			catalogs.set(row.id, { until: Date.now() + CATALOG_TTL_MS, catalog, features });
		} catch (err) {
			reachable = false;
			problem = publicMessage(err);
		}
	}
	return { server, catalog, features, reachable, problem };
};
