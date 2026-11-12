import { apiJson, route } from '$lib/server/http';
import { requireUser } from '$lib/server/access';
import { ACTIONS } from '$lib/server/actions';

export const GET = route(async ({ locals }) => {
	requireUser(locals);
	return apiJson({
		ok: true,
		actions: Object.fromEntries(
			Object.entries(ACTIONS).map(([k, v]) => [
				k,
				// `owner`: only an owner of the server's organisation, in person (never a key)
				{ cap: v.cap, mutating: v.mutating, ...(v.manager ? { owner: true } : {}) }
			])
		)
	});
});
