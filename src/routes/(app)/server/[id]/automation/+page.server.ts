import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireServerCap } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { feedStatus } from '$lib/server/feed';
import { steamEnabled } from '$lib/server/steam';
import { listTriggers } from '$lib/server/triggers';
import { staffCallHooks } from '$lib/server/webhook-delivery';

/**
 * Checked here as well as in the server layout: a page's data can be asked for without its
 * layouts (SvelteKit's __data.json), so the layout's refusal protects nothing below it. Viewers
 * see the rules read-only.
 */
export const load: PageServerLoad = async ({ locals, params, depends }) => {
	const env = getEnv();
	// re-read on its own when a Bounty rule acts (its open bounty is on the row)
	depends('warcon:triggers');
	try {
		const { server } = await requireServerCap(env, locals, params.id, 'automation.manage');
		// What the kinds need before they can run here, so the Add menu and the editor can say so,
		// and whether the kill feed reaches the panel, for the rules that act on it. For a Staff call
		// rule, how many of the organisation's Discord webhooks would carry a call from this server:
		// the count alone (the webhooks are their owners'), so a rule that reaches nobody says so.
		return {
			triggers: await listTriggers(env, server.id),
			steam: steamEnabled(env),
			feed: !!server.feedTokenHash,
			feedStatus: await feedStatus(env, server, false),
			staffHooks: await staffCallHooks(env, server)
		};
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
};
