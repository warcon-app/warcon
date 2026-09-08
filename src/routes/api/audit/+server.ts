import { getEnv } from '$lib/server/env';
import { apiJson, route } from '$lib/server/http';
import { adminServerIds, requireUser } from '$lib/server/access';
import { auditFilters, queryAudit } from '$lib/server/audit';

export const GET = route(async ({ locals, url }) => {
	const env = getEnv();
	const user = requireUser(locals);
	const visibleTo =
		user.role === 'owner'
			? null
			: { userId: user.id, adminServerIds: await adminServerIds(env, user) };
	return apiJson({
		ok: true,
		...(await queryAudit(env, { ...auditFilters(url.searchParams), visibleTo }))
	});
});
