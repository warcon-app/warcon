import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { auditVisibility, requireUser } from '$lib/server/access';
import { auditFilters, auditMeta, queryAudit } from '$lib/server/audit';

export const load: PageServerLoad = async ({ locals, url }) => {
	const env = getEnv();
	const user = requireUser(locals);
	const visibleTo = await auditVisibility(env, user);
	const filters = auditFilters(url.searchParams);
	const [page, meta] = await Promise.all([
		queryAudit(env, { ...filters, visibleTo, limit: 100 }),
		auditMeta(env)
	]);
	return {
		entries: page.entries,
		nextBefore: page.nextBefore,
		filters,
		actions: meta.actions,
		actors: meta.actors
	};
};
