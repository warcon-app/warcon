import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { archiveGroup, groupOf, updateGroup } from '$lib/server/slot-groups';

/** Renames a group or changes its servers: `{ name?, servers?: "every" | [serverId] }`. */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const group = await groupOf(env, org, param(event, 'groupId'));
	const result = await updateGroup(
		env,
		event.request,
		user,
		org,
		group,
		await readJson(event.request)
	);
	return apiJson({ ok: true, ...result });
});

/** Takes a group away: off for good, its entries and history kept. */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const group = await groupOf(env, org, param(event, 'groupId'));
	return apiJson({ ok: true, ...(await archiveGroup(env, event.request, user, org, group)) });
});
