import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { createGroup, groupsView } from '$lib/server/slot-groups';

/** The org's reserved-slot groups, for those who edit its reserved slots. */
export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	return apiJson({ ok: true, groups: await groupsView(env, org) });
});

/** A new group: `{ name, servers: "every" | [serverId] }`, off until switched on. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'reserve');
	const result = await createGroup(env, event.request, user, org, await readJson(event.request));
	return apiJson({ ok: true, ...result }, 201);
});
