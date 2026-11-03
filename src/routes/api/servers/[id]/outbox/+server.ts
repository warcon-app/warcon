// The last trigger actions on this server and what became of them; `rule` (up to ten) narrows
// them to those rules' own, from the last week.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route, str } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { recentOutbox } from '$lib/server/outbox';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'automation.manage'
	);
	const rules = event.url.searchParams
		.getAll('rule')
		.slice(0, 10)
		.map((r) => str(r, 64))
		.filter(Boolean);
	return apiJson({ ok: true, items: await recentOutbox(env, server.id, 40, rules) });
});
