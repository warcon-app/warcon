// An announcement: one message broadcast on several of the organisation's servers at once
// (announce.ts). Whoever may chat on those servers, people and keys alike; 200 when at least one
// server took it, with how each did, else 502 with the same list.
import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireUser } from '$lib/server/access';
import { announce, announceAccess } from '$lib/server/announce';

export const POST = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { org, visible } = await announceAccess(env, user, param(event, 'id'));
	const answer = await announce(
		env,
		event.request,
		user,
		org,
		visible,
		await readJson(event.request)
	);
	if (answer.sent) return apiJson({ ok: true, ...answer });
	return apiJson(
		{
			ok: false,
			error: { message: 'No server took the announcement.', code: 'not_sent' },
			...answer
		},
		502
	);
});
