import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { groupOf, removeGroupEntry, updateGroupEntry } from '$lib/server/slot-groups';

/** Changes the note or the expiry of a player's entry in the group. */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const group = await groupOf(env, org, param(event, 'groupId'));
	const result = await updateGroupEntry(
		env,
		event.request,
		user,
		org,
		group,
		param(event, 'steamId'),
		await readJson(event.request)
	);
	return apiJson({ ok: true, ...result });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const group = await groupOf(env, org, param(event, 'groupId'));
	const result = await removeGroupEntry(
		env,
		event.request,
		user,
		org,
		group,
		param(event, 'steamId')
	);
	return apiJson({ ok: true, ...result });
});
