// {kind, config}: replays the last 24 hours against a rule (saved or not) without acting.
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, param, readJson, route } from '$lib/server/http';
import { requireServerRole } from '$lib/server/access';
import { gateway } from '$lib/server/gateway';
import { dryRun, isTriggerKind } from '$lib/server/triggers';

export const POST = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'admin');
	const body = await readJson(event.request);
	if (!isTriggerKind(body.kind)) throw new ApiError(400, 'Unknown trigger kind.');
	const reserved = () =>
		gateway()
			.run(env, server, 'reserved', {})
			.then((r) => (r as { reserved: string[] }).reserved);
	return apiJson({ ok: true, result: await dryRun(env, server, body.kind, body.config, reserved) });
});
