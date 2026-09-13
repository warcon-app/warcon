import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { createBoard, listBoards } from '$lib/server/boards';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	return apiJson({ ok: true, boards: await listBoards(env, org.id) });
});

/** {label, url, heading, serverIds[]|null, intervalMs, showPlayers, enabled} */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	const board = await createBoard(env, event.request, user, org, body);
	return apiJson({ ok: true, board }, 201);
});
