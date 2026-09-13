// The seam between the web side and the worker. Every game request, live read, interest lease
// and "look again" goes through this interface. In the single-process role it is the in-process
// implementation below; when the web runs on its own it is the relay client (relay.ts), which
// speaks to the worker over HTTP.
import type { Env } from './env';
import type { OrgRow, ServerRow } from './access';
import type { ListSyncSummary } from '$lib/types';
import type { LiveView } from '$lib/types';
import type { WarconEvent } from './events';
import type { Priority } from './dispatcher';
import type { SyncResult } from './lists-sync';
import type { PollerStats } from './poller';

export interface Gateway {
	/** Runs a registry action on the server through its lane. */
	run(
		env: Env,
		server: ServerRow,
		action: string,
		params: Record<string, unknown>,
		priority?: Priority
	): Promise<unknown>;
	/** The latest view of these servers (from the worker's memory, else the database). */
	live(env: Env, ids: string[]): Promise<Map<string, LiveView>>;
	/** Someone is looking at these servers: keep them in the watched tier. */
	interest(ids: string[]): void;
	/** A command just went to this server: look again as soon as possible. */
	observeSoon(serverId: string): void;
	/** Observes the server now and returns the view (a server just added, a read that cannot wait). */
	observeNow(env: Env, serverId: string): Promise<LiveView | null>;
	/** Pushes an org's lists to all its servers now. */
	syncOrg(env: Env, org: OrgRow): Promise<ListSyncSummary>;
	/** Pushes the lists to one server now, waiting up to waitMs for its lane. */
	syncServer(env: Env, server: ServerRow, org: OrgRow, waitMs: number): Promise<SyncResult>;
	/** Settings were saved: the worker should re-read them. */
	settingsChanged(env: Env): Promise<void>;
	/** A trigger on this server was created, changed or deleted: drop the worker's cached rule set. */
	triggersChanged(serverId: string): void;
	/** A Discord status board was created, changed, paused or removed: the worker should re-read them now. */
	boardsChanged(): void;
	/** Live events (observations, deliveries). */
	subscribe(fn: (e: WarconEvent) => void): () => void;
	/** The worker's scheduler stats (for /api/health and the settings page). */
	health(env: Env): Promise<PollerStats>;
}

let current: Gateway | null = null;

export function setGateway(g: Gateway): void {
	current = g;
}

export function gateway(): Gateway {
	if (!current) throw new Error('Gateway not configured.');
	return current;
}
