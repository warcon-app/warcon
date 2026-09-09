import { getEnv } from '$lib/server/env';
import { apiJson, route } from '$lib/server/http';
import { auditVisibility, requireUser } from '$lib/server/access';
import { auditMeta } from '$lib/server/audit';

export const GET = route(async ({ locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	return apiJson({ ok: true, ...(await auditMeta(env, await auditVisibility(env, user))) });
});
