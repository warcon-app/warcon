import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { createWebhook, listWebhooks } from '$lib/server/webhooks';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	return apiJson({ ok: true, webhooks: await listWebhooks(env, org.id) });
});

/** {label, url, events[], serverIds[]|null, enabled} */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	const webhook = await createWebhook(env, event.request, user, org, body);
	return apiJson({ ok: true, webhook }, 201);
});
