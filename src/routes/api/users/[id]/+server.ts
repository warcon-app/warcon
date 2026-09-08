import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOwner } from '$lib/server/access';
import { deleteUser, updateUser } from '$lib/server/users';

export const PATCH = route(async (event) => {
	const env = getEnv();
	const actor = requireOwner(event.locals);
	await updateUser(
		event.locals.auth!,
		env,
		event.request,
		actor,
		param(event, 'id'),
		await readJson(event.request)
	);
	return apiJson({ ok: true });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const actor = requireOwner(event.locals);
	await deleteUser(event.locals.auth!, env, event.request, actor, param(event, 'id'));
	return apiJson({ ok: true });
});
