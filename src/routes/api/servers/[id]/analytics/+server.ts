import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { loadAnalytics, parseRange } from '$lib/server/analytics';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'server.view');
	return apiJson({
		ok: true,
		...(await loadAnalytics(env, server.id, parseRange(event.url.searchParams.get('range'))))
	});
});
