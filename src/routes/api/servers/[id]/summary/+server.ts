// Dashboard read: the worker's latest view of one server, never a game request.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { gateway } from '$lib/server/gateway';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server, access } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'server.view'
	);
	const live =
		(await gateway().live(env, [server.id])).get(server.id) ??
		(await gateway().observeNow(env, server.id));
	if (!live)
		return apiJson({
			ok: false,
			role: access.roleName,
			live: null,
			error: { message: 'Not observed yet.' }
		});
	return apiJson({
		ok: live.ok,
		role: access.roleName,
		caps: [...access.caps],
		live,
		status: live.status,
		error: live.ok ? undefined : { message: live.error }
	});
});
