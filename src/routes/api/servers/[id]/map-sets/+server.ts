// The organisation's map sets, for the Map rotation tab of one of its servers: whoever may apply
// that server's config, which is how a set is loaded. Its owners change them
// (/api/orgs/:id/map-sets).
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { mapSetsFor } from '$lib/server/map-sets';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'config.apply');
	return apiJson({ ok: true, mapSets: await mapSetsFor(env, server.orgId) });
});
