import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { getOrg, getServer, requireUser, serverAccessFor, shapeServer } from '$lib/server/access';
import { publicMessage } from '$lib/server/http';
import { gateway } from '$lib/server/gateway';
import type { Catalog, Features, ServerInfo } from '$lib/types';

const EMPTY: Catalog = { maps: [], lightings: [], experiences: [] };
/** Catalog and capabilities change with plugin builds, not with matches: one read per server per hour. */
const CATALOG_TTL_MS = 3600_000;
const catalogs = new Map<string, { until: number; catalog: Catalog; features: Features }>();

export const load: LayoutServerLoad = async ({ params, locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	// Resolved here rather than from the (app) layout's list: that list is narrowed to the header's
	// organisation scope, and a link into a server of another org must still open.
	const row = await getServer(env, params.id);
	const access = row ? await serverAccessFor(env, user, row.id) : null;
	if (!row || !access) error(404, 'Server not found, or you have no access to it.');
	const org = await getOrg(env, row.orgId);
	const server: ServerInfo = shapeServer(env, row, org?.name ?? '', access);
	let catalog: Catalog = EMPTY;
	// A build too old to report capabilities predates the route removals, so assume the live routes.
	let features: Features = {
		changeTeam: false,
		configDocument: false,
		reservedSlots: true,
		rotationEdit: true,
		rotationSave: true,
		liveSettings: true
	};
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
