// {kind, config}: replays the last 24 hours against a rule (saved or not) without acting.
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, param, readJson, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { gateway } from '$lib/server/gateway';
import { dryRun, isTriggerKind, requireRuleCaps } from '$lib/server/triggers';

export const POST = route(async (event) => {
	const env = getEnv();
	const { server, access } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'automation.manage'
	);
	const body = await readJson(event.request);
	if (!isTriggerKind(body.kind)) throw new ApiError(400, 'Unknown trigger kind.');
	// A dry run names the players a rule would act on and why: for those who could save the rule.
	requireRuleCaps(body.kind, body.config, server, access);
	// The slots the live rules go by: the server's list as the panel keeps it (its config document),
	// the running list where the build serves no document.
	const reserved = () =>
		gateway()
			.run(env, server, 'reserved', { document: 1 })
			.then((r) => {
				const { reserved, document } = r as { reserved: string[]; document?: string[] | null };
				return document ?? reserved;
			});
	return apiJson({ ok: true, result: await dryRun(env, server, body.kind, body.config, reserved) });
});
