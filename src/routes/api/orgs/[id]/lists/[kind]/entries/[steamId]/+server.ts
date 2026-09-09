import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { parseKind, removeEntry } from '$lib/server/lists';

export const DELETE = route(async (event) => {
	const env = getEnv();
	const kind = parseKind(param(event, 'kind'));
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'));
	const result = await removeEntry(env, event.request, user, org, kind, param(event, 'steamId'));
	return apiJson({ ok: true, ...result });
});
