import { apiJson, route } from '$lib/server/http';
import { requireUser } from '$lib/server/access';
import { ACTIONS } from '$lib/server/actions';

export const GET = route(async ({ locals }) => {
	requireUser(locals);
	return apiJson({
		ok: true,
		actions: Object.fromEntries(
			Object.entries(ACTIONS).map(([k, v]) => [k, { cap: v.cap, mutating: v.mutating }])
		)
	});
});
