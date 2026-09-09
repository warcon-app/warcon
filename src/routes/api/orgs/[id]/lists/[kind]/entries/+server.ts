import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { addEntry, entriesView, parseKind } from '$lib/server/lists';

export const GET = route(async (event) => {
	const env = getEnv();
	const kind = parseKind(param(event, 'kind'));
	const { org } = await requireListsRole(env, event.locals, param(event, 'id'));
	const includeRemoved = event.url.searchParams.get('includeRemoved') === '1';
	return apiJson({ ok: true, entries: await entriesView(env, org, kind, { includeRemoved }) });
});

export const POST = route(async (event) => {
	const env = getEnv();
	const kind = parseKind(param(event, 'kind'));
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'));
	const result = await addEntry(env, event.request, user, org, kind, await readJson(event.request));
	return apiJson({ ok: true, ...result }, 201);
});
