import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireServerCap, requireUser } from '$lib/server/access';
import { deleteTrigger, updateTrigger } from '$lib/server/triggers';

/** {name?, enabled?, config?} */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'automation.manage'
	);
	const body = await readJson(event.request);
	const trigger = await updateTrigger(
		env,
		event.request,
		user,
		server,
		param(event, 'triggerId'),
		body
	);
	return apiJson({ ok: true, trigger });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'automation.manage'
	);
	await deleteTrigger(env, event.request, user, server, param(event, 'triggerId'));
	return apiJson({ ok: true });
});
