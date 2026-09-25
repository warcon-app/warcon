import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { getOrg, getServer, requireUser, serverAccessFor, shapeServer } from '$lib/server/access';
import { publicMessage } from '$lib/server/http';
import { gateway } from '$lib/server/gateway';
import { cachedCatalog, rememberCatalog } from '$lib/server/catalog-cache';
import type { Catalog, Features, ServerInfo } from '$lib/types';

const EMPTY: Catalog = { maps: [], lightings: [], experiences: [] };

export const load: LayoutServerLoad = async ({ params, locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	// Resolved here rather than from the (app) layout's list: that list is narrowed to the header's
	// organisation scope, and a link into a server of another org must still open.
	const row = await getServer(env, params.id);
	const access = row ? await serverAccessFor(env, user, row.id) : null;
	if (!row || !access) error(404, 'Server not found, or you have no access to it.');
	const org = await getOrg(env, row.orgId);
	const server: ServerInfo = shapeServer(
		env,
		row,
		org ?? { name: '', allowPublicStatus: false, allowPublicLeaderboards: false, allowPublicMatches: false },
		access
	);
	let catalog: Catalog = EMPTY;
	// A build too old to report capabilities predates the route removals, so assume the live routes.
	let features: Features = {
		changeTeam: false,
		configDocument: false,
		reservedSlots: true,
		rotationEdit: true,
		rotationSave: true,
		liveSettings: true,
		serverId: false
	};
	let reachable = true;
	let problem = '';
	const hit = cachedCatalog(row.id);
	if (hit) {
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
			rememberCatalog(row.id, { catalog, features });
		} catch (err) {
			reachable = false;
			problem = publicMessage(err);
		}
	}
	// What the worker last learned about the build: never a game request from a page load, and
	// never a reason for the page to fail (the worker may be down or the relay slow).
	let identity: { build: string; gameServerId: string; startedAt: string | null } = {
		build: '',
		gameServerId: '',
		startedAt: null
	};
	try {
		const live = (await gateway().live(env, [row.id])).get(row.id);
		identity = {
			build: live?.build ?? '',
			gameServerId: live?.gameServerId ?? '',
			startedAt: live?.startedAt ?? null
		};
	} catch {
		/* shown without an id until the worker answers */
	}
	return { server, catalog, features, reachable, problem, identity };
};
