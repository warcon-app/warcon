import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { groupOf, switchGroup } from '$lib/server/slot-groups';

/** `{ on: false }`, `{ on: true, until: ISO | null }` or `{ on: true, from: ISO, until: ISO }`. */
export const PUT = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const group = await groupOf(env, org, param(event, 'groupId'));
	const result = await switchGroup(
		env,
		event.request,
		user,
		org,
		group,
		await readJson(event.request)
	);
	return apiJson({ ok: true, ...result });
});
