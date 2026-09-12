import { getEnv } from '$lib/server/env';
import { apiJson, int, param, route } from '$lib/server/http';
import { requireServerCap, requireUser } from '$lib/server/access';
import { deleteNote, requireSteamId } from '$lib/server/players';

/** The author, or someone whose role includes "Others' notes", removes a note. */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server, access } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'players.notes'
	);
	const steamId = requireSteamId(param(event, 'steamId'));
	await deleteNote(
		env,
		event.request,
		user,
		server,
		access,
		steamId,
		int(param(event, 'noteId'), 0, 1)
	);
	return apiJson({ ok: true });
});
