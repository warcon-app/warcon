// In-process event bus: the worker publishes a LiveView after every observation that changed
// something; the web's SSE route fans it out to browsers. When web and worker run as separate
// processes the web subscribes to the worker's relay stream and re-emits here.
import type { KillView, LiveView } from '$lib/types';
import { forLog } from './http';

export interface LiveEvent {
	type: 'live';
	live: LiveView;
}
export interface OutboxEvent {
	type: 'outbox';
	serverId: string;
	id: number;
	state: string;
}
/** Kills the feed just delivered for a server (feed.ts), newest last. */
export interface KillsEvent {
	type: 'kills';
	serverId: string;
	kills: KillView[];
}
export type WarconEvent = LiveEvent | OutboxEvent | KillsEvent;

type Listener = (e: WarconEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function emit(e: WarconEvent): void {
	for (const fn of listeners) {
		try {
			fn(e);
		} catch (err) {
			console.error('[warcon] event listener', forLog(err));
		}
	}
}

export const listenerCount = (): number => listeners.size;
