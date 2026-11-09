import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { addGroupEntry, groupEntriesView, groupOf } from '$lib/server/slot-groups';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const group = await groupOf(env, org, param(event, 'groupId'));
	const includeRemoved = event.url.searchParams.get('includeRemoved') === '1';
	return apiJson({
		ok: true,
		entries: await groupEntriesView(env, org, group, { includeRemoved })
	});
});

export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const group = await groupOf(env, org, param(event, 'groupId'));
	const result = await addGroupEntry(
		env,
		event.request,
		user,
		org,
		group,
		await readJson(event.request)
	);
	return apiJson({ ok: true, ...result }, 201);
});
