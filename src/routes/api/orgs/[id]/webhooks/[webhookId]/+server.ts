import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { deleteWebhook, updateWebhook } from '$lib/server/webhooks';

export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	const webhook = await updateWebhook(
		env,
		event.request,
		user,
		org,
		param(event, 'webhookId'),
		body
	);
	return apiJson({ ok: true, webhook });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteWebhook(env, event.request, user, org, param(event, 'webhookId'));
	return apiJson({ ok: true });
});
