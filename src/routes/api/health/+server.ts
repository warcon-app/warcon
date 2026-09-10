import { getEnv } from '$lib/server/env';
import { apiJson } from '$lib/server/http';
import { gateway } from '$lib/server/gateway';

export const GET = async () => {
	const env = getEnv();
	const worker = await gateway()
		.health(env)
		.catch((err) => ({ enabled: false, error: err instanceof Error ? err.message : String(err) }));
	return apiJson({ ok: true, service: 'warcon', role: env.WARCON_ROLE, worker });
};
