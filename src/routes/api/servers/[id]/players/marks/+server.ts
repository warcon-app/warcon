// GET ?ids=a,b,c&names=… → watchlist, first-visit and risk marks for the players table.
// Names travel with the ids so "resembles a banned player" can be judged for the current name.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route, str } from '$lib/server/http';
import { requireServerRole } from '$lib/server/access';
import { marksFor } from '$lib/server/players';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'viewer');
	const ids = (event.url.searchParams.get('ids') || '').split(',').map((s) => s.trim());
	const names = (event.url.searchParams.get('names') || '').split('\n');
	const players = ids
		.filter((id) => /^\d{17}$/.test(id))
		.slice(0, 200)
		.map((steamId, i) => ({ steamId, name: str(names[i], 100) }));
	return apiJson({ ok: true, marks: await marksFor(env, server, players) });
});
