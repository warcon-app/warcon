// The in-process gateway: the worker runs in this process, so everything is a function call.
import type { Env } from './env';
import type { OrgRow, ServerRow } from './access';
import { LaneFull, LaneTimeout, PRIORITY, withServer, type Priority } from './dispatcher';
import { actionDef } from './actions';
import { ApiError } from './http';
import { WardogsClient } from './rcon';
import { subscribe } from './events';
import { touchInterest } from './interest';
import { fanOut, reconcileServer } from './lists-sync';
import { liveView, readLiveRows } from './live';
import { memoryOf, requestIdentityRefresh } from './observe';
import { observeNow, observeSoon, pollerStats, resyncSoon } from './poller';
import { loadSettings, settings } from './settings';
import { invalidateTriggers } from './triggers';
import { nudgeStatusMirror } from './webhook-status';
import type { Gateway } from './gateway';
import type { KillView, LiveView } from '$lib/types';
import { onKillsIngested } from './feed-events';

/** Runs one registry action against a server through its lane. */
export async function runGameAction(
	env: Env,
	server: ServerRow,
	action: string,
	params: Record<string, unknown>,
	priority: Priority
): Promise<unknown> {
	const def = actionDef(action);
	if (!def) throw new ApiError(404, `Unknown action '${action}'.`, 'unknown_action');
	try {
		return await withServer(server.id, priority, async () => {
			const client = await WardogsClient.forServer(env, server);
			return def.run(client, params);
		});
	} catch (err) {
		if (err instanceof LaneFull) throw new ApiError(503, err.message, 'server_busy');
		if (err instanceof LaneTimeout) throw new ApiError(504, err.message, 'server_busy');
		throw err;
	}
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
	observeSoon(serverId: string, opts?: { lists?: boolean }) {
		observeSoon(serverId, opts);
	},
	observeNow(env: Env, serverId: string) {
		return observeNow(env, serverId);
	},
	async syncOrg(env: Env, org: OrgRow) {
		const summary = await fanOut(env, org);
		for (const s of summary.servers) resyncSoon(s.serverId);
		return summary;
	},
	async syncServer(env: Env, server: ServerRow, org: OrgRow, waitMs: number) {
		const result = await reconcileServer(env, server, org, {
			reason: 'api',
			waitMs,
			lane: PRIORITY.command
		});
		resyncSoon(server.id);
		return result;
	},
	async settingsChanged(env: Env) {
		await loadSettings(env);
	},
	triggersChanged(serverId: string) {
		invalidateTriggers(serverId);
	},
	identityChanged(serverId: string) {
		requestIdentityRefresh(serverId);
	},
	statusChanged() {
		nudgeStatusMirror();
	},
	killsIngested(env: Env, serverId: string, kills: KillView[]) {
		void onKillsIngested(env, serverId, kills);
	},
	subscribe,
	health() {
		return pollerStats();
	}
};
