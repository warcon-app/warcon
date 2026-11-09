// The organisation's map sets: rotations saved under a name, which a server's Map rotation tab
// loads in place of its rotation. Owners only, as the Map sets tab is; never a key.
import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { createMapSet } from '$lib/server/map-sets';

/** {name, entries}: a new map set, its name unique in the organisation ignoring case. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const mapSet = await createMapSet(env, event.request, user, org, await readJson(event.request));
	return apiJson({ ok: true, mapSet }, 201);
});
