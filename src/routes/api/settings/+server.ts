// Owner-only runtime settings: GET lists them with bounds and effective values, PUT saves
// {values: {key: number}, reset: [key]} and tells the worker to re-read them.
import { getEnv } from '$lib/server/env';
import { apiJson, readJson, route } from '$lib/server/http';
import { requireOwner } from '$lib/server/access';
import { writeAudit } from '$lib/server/audit';
import { gateway } from '$lib/server/gateway';
import { resetSetting, saveSettings, settingsView } from '$lib/server/settings';

export const GET = route(async (event) => {
	const env = getEnv();
	requireOwner(event.locals);
	return apiJson({ ok: true, settings: await settingsView(env) });
});

export const PUT = route(async (event) => {
	const env = getEnv();
	const user = requireOwner(event.locals);
	const body = await readJson<{ values?: Record<string, unknown>; reset?: string[] }>(
		event.request
	);
	const reset = Array.isArray(body.reset) ? body.reset.map(String) : [];
	for (const key of reset) await resetSetting(env, key);
	const { changed } = await saveSettings(env, body.values ?? {}, user.id);
	if (reset.length || Object.keys(changed).length) {
		await writeAudit(env, event.request, {
			actor: user,
			category: 'system',
			action: 'settings.update',
			target: [...Object.keys(changed), ...reset.map((k) => `${k} (reset)`)].join(', '),
			outcome: 'ok',
			detail: { changed, reset }
		});
		await gateway().settingsChanged(env);
	}
	return apiJson({ ok: true, settings: await settingsView(env), changed, reset });
});
