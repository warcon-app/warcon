import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireServerRole, requireUser } from '$lib/server/access';
import { addNote, requireSteamId } from '$lib/server/players';

/** {body}: operators and up leave notes. */
export const POST = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'operator');
	const steamId = requireSteamId(param(event, 'steamId'));
	const body = await readJson(event.request);
	const note = await addNote(env, event.request, user, server, steamId, body.body);
	return apiJson({ ok: true, note }, 201);
});
