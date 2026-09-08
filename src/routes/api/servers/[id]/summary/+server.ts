// Dashboard read: status of one server, never throws for game-side failures.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerRole } from '$lib/server/access';
import { ACTIONS } from '$lib/server/actions';
import { WardogsClient } from '$lib/server/rcon';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server, role } = await requireServerRole(env, event.locals, param(event, 'id'), 'viewer');
	const started = Date.now();
	try {
		const client = await WardogsClient.forServer(env, server);
		const status = await ACTIONS.status.run(client, {});
		return apiJson({ ok: true, role, status, durationMs: Date.now() - started });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return apiJson({ ok: false, role, error: { message }, durationMs: Date.now() - started });
	}
});
