// The in-process gateway: the worker runs in this process, so everything is a function call.
import type { Env } from './env';
import type { OrgRow, ServerRow } from './access';
import { LaneFull, LaneTimeout, PRIORITY, withServer, type Priority } from './dispatcher';
import { ACTIONS } from './actions';
import { ApiError, str } from './http';
import { WardogsClient } from './rcon';
import { subscribe } from './events';
import { touchInterest } from './interest';
import { fanOut, reconcileServer } from './lists-sync';
import { liveView, readLiveRows } from './live';
import { memoryOf, requestIdentityRefresh } from './observe';
import { observeNow, observeSoon, pollerStats, resyncSoon } from './poller';
import { loadSettings, settings } from './settings';
import { invalidateTriggers, noteStaffMove } from './triggers';
import { nudgeStatusMirror } from './webhook-status';
import type { Gateway } from './gateway';
import type { KillView, LiveView } from '$lib/types';
import { onKillsIngested } from './feed-events';
import { onMatchFeed, type MatchFeed } from './match-feed';

/**
 * The player and faction a person's action moved, or null: `changeTeam` (which throws when the game
 * refuses), or a raw PATCH of one player's faction that the game answered with a 2xx (raw hands
 * back the game's status rather than throwing). A Team balance rule takes that side as placed
 * (noteStaffMove).
 */
export function staffMoveOf(
	action: string,
	params: Record<string, unknown>,
	result: unknown
): { steamId: string; faction: string } | null {
	let body = (action === 'raw' ? params.body : params) as Record<string, unknown> | undefined;
	if (typeof body === 'string')
		try {
			body = JSON.parse(body);
		} catch {
			return null;
		}
	const faction = typeof body?.faction === 'string' ? body.faction.trim() : '';
	if (!faction) return null;
	if (action === 'changeTeam' && typeof params.steamId === 'string')
		return /^\d{17}$/.test(params.steamId.trim())
			? { steamId: params.steamId.trim(), faction }
			: null;
	if (action !== 'raw' || String(params.method ?? '').toUpperCase() !== 'PATCH') return null;
	const status = (result as { status?: unknown } | null)?.status;
	if (typeof status !== 'number' || status < 200 || status > 299) return null;
	const m = /^\/v1\/players\/(\d{17})\/?$/i.exec(String(params.path ?? '').trim());
	return m ? { steamId: m[1], faction } : null;
}

/**
 * A move kills the player so they respawn on the new side. A move to the side they are already on
 * would be that kill and nothing else, so Move alone could kill anyone: it is refused, whoever asks,
 * judged from the player list the worker last read. A player missing from that list goes to the
 * game, which answers for them.
 */
function refuseSameSide(serverId: string, params: Record<string, unknown>): void {
	const steamId = str(params.steamId, 32);
	const faction = str(params.faction, 100).toLowerCase();
	const on = memoryOf(serverId)?.players.find((p) => p.steamId === steamId)?.faction;
	if (faction && on?.trim().toLowerCase() === faction)
		throw new ApiError(409, `That player is already on ${on}.`, 'same_side');
}

/** Runs one registry action against a server through its lane: a person's, from the web or the API. */
export async function runGameAction(
	env: Env,
	server: ServerRow,
	action: string,
	params: Record<string, unknown>,
	priority: Priority
): Promise<unknown> {
	const def = ACTIONS[action];
	if (!def) throw new ApiError(404, `Unknown action '${action}'.`, 'unknown_action');
	try {
		return await withServer(server.id, priority, async () => {
			if (action === 'changeTeam') refuseSameSide(server.id, params);
			const client = await WardogsClient.forServer(env, server);
			const result = await def.run(client, params);
			const moved = staffMoveOf(action, params, result);
			if (moved) noteStaffMove(server.id, moved.steamId, moved.faction);
			return result;
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
	matchFeed(env: Env, serverId: string, feed: MatchFeed) {
		void onMatchFeed(env, memoryOf(serverId), feed);
	},
	subscribe,
	health() {
		return pollerStats();
	}
};
