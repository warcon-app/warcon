import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { deleteBoard, updateBoard } from '$lib/server/boards';

export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	const board = await updateBoard(env, event.request, user, org, param(event, 'boardId'), body);
	return apiJson({ ok: true, board });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteBoard(env, event.request, user, org, param(event, 'boardId'));
	return apiJson({ ok: true });
});
