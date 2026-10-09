import { untrack } from 'svelte';
import type { LiveView } from './types';

/** Last known reachability per server id, shown as the pulse dot in the switcher and dashboard. */
export const health = $state<Record<string, boolean>>({});
/** Servers whose listener asked the panel to slow down (429 with Retry-After), and until when. */
export const throttled = $state<Record<string, string | null>>({});
/** What the worker knows about each server's build, as the live stream reports it. */
export interface Identity {
	build: string;
	gameServerId: string;
	startedAt: string | null;
	/** RestartTimeUtc in effect and in the config document (LiveView) */
	restartTimeUtc: string | null;
	restartTimeUtcFile: string | null;
}
export const identity = $state<Record<string, Identity>>({});

export interface Occupancy {
	players: number;
	max: number;
}
/** Players on each server as of the last look; null while the last look failed. */
export const occupancy = $state<Record<string, Occupancy | null>>({});

export function setHealth(id: string, ok: boolean) {
	// untrack: an $effect that calls this must not depend on the value it is about to overwrite,
	// or every poll-driven change would re-run it and restore the old value.
	if (untrack(() => health[id]) !== ok) health[id] = ok;
}

const expiry = new Map<string, ReturnType<typeof setTimeout>>();

/** Every live view the browser receives passes through here, so headers need no stream of their own. */
export function noteLive(v: LiveView) {
	setHealth(v.serverId, v.ok);
	const until =
		v.throttledUntil && Date.parse(v.throttledUntil) > Date.now() ? v.throttledUntil : null;
	if (untrack(() => throttled[v.serverId]) !== until) throttled[v.serverId] = until;
	// A hold ends on its own; without another event the indicator would otherwise stay amber.
	clearTimeout(expiry.get(v.serverId));
	if (until)
		expiry.set(
			v.serverId,
			setTimeout(
				() => {
					if (throttled[v.serverId] === until) throttled[v.serverId] = null;
				},
				Math.max(0, Date.parse(until) - Date.now())
			)
		);
	const occ = v.ok && v.status ? { players: v.status.playerCount, max: v.status.maxPlayers } : null;
	const had = untrack(() => occupancy[v.serverId]);
	if (had === undefined || had?.players !== occ?.players || had?.max !== occ?.max)
		occupancy[v.serverId] = occ;
	if (v.build || v.gameServerId || v.startedAt) {
		const cur = untrack(() => identity[v.serverId]);
		const next: Identity = {
			build: v.build,
			gameServerId: v.gameServerId,
			startedAt: v.startedAt,
			restartTimeUtc: v.restartTimeUtc ?? null,
			restartTimeUtcFile: v.restartTimeUtcFile ?? null
		};
		if (!cur || (Object.keys(next) as (keyof Identity)[]).some((k) => cur[k] !== next[k]))
			identity[v.serverId] = next;
	}
}
