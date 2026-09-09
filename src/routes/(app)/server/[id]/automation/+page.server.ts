import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { steamEnabled } from '$lib/server/steam';
import { listTriggers } from '$lib/server/triggers';

/** The server layout already refused anyone without access; viewers see the rules read-only. */
export const load: PageServerLoad = async ({ params }) => {
	const env = getEnv();
	return { triggers: await listTriggers(env, params.id), steam: steamEnabled(env) };
};
