import { getEnv } from '$lib/server/env';
import { apiJson, readJson, route } from '$lib/server/http';
import { ownedOrgIds, requireUser } from '$lib/server/access';
import { createOrg, listOrgs } from '$lib/server/orgs';
import { assertMayCreateOrg } from '$lib/server/signup';

/** Orgs the caller runs (every org for the site owner). */
export const GET = route(async ({ locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	return apiJson({ ok: true, orgs: await listOrgs(env, await ownedOrgIds(env, user)) });
});

/** The site owner always; anyone under the cap when ALLOW_ORG_SIGNUP is on. The creator becomes its first owner. */
export const POST = route(async ({ locals, request }) => {
	const env = getEnv();
	const actor = requireUser(locals);
	await assertMayCreateOrg(env, actor);
	const id = await createOrg(env, request, actor, await readJson(request));
	return apiJson({ ok: true, id }, 201);
});
