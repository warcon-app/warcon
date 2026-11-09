// The organisation's saved messages, for the chat boxes of one of its servers: whoever may chat
// there. Its owners change them (PATCH /api/orgs/:id {savedMessages}).
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { savedMessagesFor } from '$lib/server/saved-messages';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'chat.send');
	return apiJson({ ok: true, messages: await savedMessagesFor(env, server.orgId) });
});
