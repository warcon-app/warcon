import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { getOrg, getServer, requireUser, serverAccessFor, shapeServer } from '$lib/server/access';
import { publicMessage } from '$lib/server/http';
import { gateway } from '$lib/server/gateway';
import { cachedCatalog, catalogReadFailed, rememberCatalog } from '$lib/server/catalog-cache';
import type { Identity, Occupancy } from '$lib/health.svelte';
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
		org ?? { name: '', allowPublicStatus: false, allowPublicLeaderboards: false },
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
		serverId: false,
		chat: false
	};
	let reachable = true;
	let problem = '';
	// What the worker last learned about the build: never a game request from a page load, and
	// never a reason for the page to fail (the worker may be down or the relay slow).
	let identity: Identity = {
		build: '',
		gameServerId: '',
		startedAt: null,
		restartTimeUtc: null,
		restartTimeUtcFile: null
	};
	let occupancy: Occupancy | null = null;
	try {
		const live = (await gateway().live(env, [row.id])).get(row.id);
		identity = {
			build: live?.build ?? '',
			gameServerId: live?.gameServerId ?? '',
			startedAt: live?.startedAt ?? null,
			restartTimeUtc: live?.restartTimeUtc ?? null,
			restartTimeUtcFile: live?.restartTimeUtcFile ?? null
		};
		if (live?.ok && live.status)
			occupancy = { players: live.status.playerCount, max: live.status.maxPlayers };
	} catch {
		/* shown without an id until the worker answers */
	}
	// The catalog and the routes the build serves, read once an hour and again once the game has
	// restarted: that is when it takes a new build or new allow lists (catalog-cache.ts). A read
	// that fails after a restart leaves the pages on what was read before it.
	const startedAt = (identity.startedAt && Date.parse(identity.startedAt)) || 0;
	const hit = cachedCatalog(row.id, startedAt);
	if (hit) {
		catalog = hit.entry.catalog;
		features = hit.entry.features;
	}
	if (!hit || hit.due) {
		try {
			const read = (await gateway().run(env, row, 'catalog', {})) as Catalog;
			let served = features;
			try {
				served = ((await gateway().run(env, row, 'capabilities', {})) as { features: Features })
					.features;
			} catch {
				/* older plugin builds have no capabilities route */
			}
			catalog = read;
			features = served;
			rememberCatalog(row.id, { catalog, features }, startedAt);
		} catch (err) {
			if (hit) catalogReadFailed(row.id);
			else {
				reachable = false;
				problem = publicMessage(err);
			}
		}
	}
	return { server, catalog, features, reachable, problem, identity, occupancy };
};
