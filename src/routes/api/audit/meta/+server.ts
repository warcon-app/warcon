import { getEnv } from '$lib/server/env';
import { apiJson, route } from '$lib/server/http';
import { requireUser } from '$lib/server/access';
import { auditMeta } from '$lib/server/audit';

export const GET = route(async ({ locals }) => {
	const env = getEnv();
	requireUser(locals);
	return apiJson({ ok: true, ...(await auditMeta(env)) });
});
