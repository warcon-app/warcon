import { getEnv } from '$lib/server/env';
import { apiJson, readJson, route } from '$lib/server/http';
import { ownedOrgIds, requireOwner, requireUser } from '$lib/server/access';
import { createOrg, listOrgs } from '$lib/server/orgs';

/** Orgs the caller runs (every org for the site owner). */
export const GET = route(async ({ locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	return apiJson({ ok: true, orgs: await listOrgs(env, await ownedOrgIds(env, user)) });
});

/** Only the site owner creates orgs; the creator becomes its first owner. */
export const POST = route(async ({ locals, request }) => {
	const env = getEnv();
	const actor = requireOwner(locals);
	const id = await createOrg(env, request, actor, await readJson(request));
	return apiJson({ ok: true, id }, 201);
});
