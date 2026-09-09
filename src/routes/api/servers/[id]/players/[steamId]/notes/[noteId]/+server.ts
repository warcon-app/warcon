import { getEnv } from '$lib/server/env';
import { apiJson, int, param, route } from '$lib/server/http';
import { requireServerRole, requireUser } from '$lib/server/access';
import { deleteNote, requireSteamId } from '$lib/server/players';

/** The author, or an admin on this server, removes a note. */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server, role } = await requireServerRole(
		env,
		event.locals,
		param(event, 'id'),
		'operator'
	);
	const steamId = requireSteamId(param(event, 'steamId'));
	await deleteNote(
		env,
		event.request,
		user,
		server,
		role,
		steamId,
		int(param(event, 'noteId'), 0, 1)
	);
	return apiJson({ ok: true });
});
