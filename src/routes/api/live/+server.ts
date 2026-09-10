// The worker's latest view of the servers the caller may see: ?ids=a,b (default: all of them).
import { getEnv } from '$lib/server/env';
import { apiJson, route } from '$lib/server/http';
import { accessibleServers, requireUser } from '$lib/server/access';
import { gateway } from '$lib/server/gateway';

export const GET = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const mine = new Set((await accessibleServers(env, user)).map((s) => s.id));
	const asked = (event.url.searchParams.get('ids') || '').split(',').filter(Boolean);
	const ids = (asked.length ? asked : [...mine]).filter((id) => mine.has(id));
	const live = await gateway().live(env, ids);
	return apiJson({ ok: true, live: Object.fromEntries(live) });
});
