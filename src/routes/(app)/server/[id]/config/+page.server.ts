import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireServerCap } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { triggers } from '$lib/server/db/schema';

/**
 * The Config tab reads the document through the game actions, each with its own check. This says
 * only whether a Live server name rule keeps the server's name, and only to those who can apply the
 * document (an edit of the name that the rule would write over): nothing of the rule's settings, and
 * nothing to a viewer, whose View is not about how the server is run.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	let found;
	try {
		found = await requireServerCap(env, locals, params.id, 'server.view');
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
	const { server, access } = found;
	if (!access.caps.has('config.apply')) return { liveName: false };
	const [rule] = await env.db
		.select({ id: triggers.id })
		.from(triggers)
		.where(
			and(
				eq(triggers.serverId, server.id),
				eq(triggers.kind, 'live_name'),
				eq(triggers.enabled, true)
			)
		)
		.limit(1);
	return { liveName: !!rule };
};
