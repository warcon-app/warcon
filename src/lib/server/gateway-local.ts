// The in-process gateway: the worker runs in this process, so everything is a function call.
import type { Env } from './env';
import type { OrgRow, ServerRow } from './access';
import { PRIORITY, withServer, type Priority } from './dispatcher';
import { ACTIONS } from './actions';
import { ApiError } from './http';
import { WardogsClient } from './rcon';
import { subscribe } from './events';
import { touchInterest } from './interest';
import { fanOut, reconcileServer } from './lists-sync';
import { liveView, readLiveRows } from './live';
import { memoryOf } from './observe';
import { observeNow, observeSoon, pollerStats } from './poller';
import { loadSettings, settings } from './settings';
import type { Gateway } from './gateway';
import type { LiveView } from '$lib/types';

/** Runs one registry action against a server through its lane. */
export async function runGameAction(
	env: Env,
	server: ServerRow,
	action: string,
	params: Record<string, unknown>,
	priority: Priority
): Promise<unknown> {
	const def = ACTIONS[action];
	if (!def) throw new ApiError(404, `Unknown action '${action}'.`, 'unknown_action');
	return withServer(server.id, priority, async () => {
		const client = await WardogsClient.forServer(env, server);
		return def.run(client, params);
	});
}

export const localGateway: Gateway = {
	run(env, server, action, params, priority: Priority = PRIORITY.command) {
		return runGameAction(env, server, action, params, priority);
	},
	async live(env: Env, ids: string[]): Promise<Map<string, LiveView>> {
		const out = new Map<string, LiveView>();
		const missing: string[] = [];
		for (const id of ids) {
			const m = memoryOf(id);
			if (m && m.observedAt) out.set(id, liveView(m));
			else missing.push(id);
		}
		if (missing.length) for (const [id, v] of await readLiveRows(env, missing)) out.set(id, v);
		return out;
	},
	interest(ids: string[]) {
		touchInterest(ids, settings().watchLeaseMs);
	},
	observeSoon(serverId: string) {
		observeSoon(serverId);
	},
	observeNow(env: Env, serverId: string) {
		return observeNow(env, serverId);
	},
	syncOrg(env: Env, org: OrgRow) {
		return fanOut(env, org);
	},
	syncServer(env: Env, server: ServerRow, org: OrgRow, waitMs: number) {
		return reconcileServer(env, server, org, { reason: 'api', waitMs, lane: PRIORITY.command });
	},
	async settingsChanged(env: Env) {
		await loadSettings(env);
	},
	subscribe,
	health() {
		return pollerStats();
	}
};
