import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { importCandidates, importEntries } from '$lib/server/lists';

/** Bans and reserved slots on the org's servers that the org list does not hold yet. */
export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireListsRole(env, event.locals, param(event, 'id'));
	return apiJson({ ok: true, candidates: await importCandidates(env, org) });
});

/** Adopt some of them: owners only, since it makes the panel responsible for lifting them later. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	return apiJson({
		ok: true,
		...(await importEntries(env, event.request, user, org, body.entries))
	});
});
