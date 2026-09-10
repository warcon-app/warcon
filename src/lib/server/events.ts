// In-process event bus: the worker publishes a LiveView after every observation that changed
// something; the web's SSE route fans it out to browsers. When web and worker run as separate
// processes the web subscribes to the worker's relay stream and re-emits here.
import type { LiveView } from '$lib/types';

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
export type WarconEvent = LiveEvent | OutboxEvent;

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
			console.error('[warcon] event listener', err);
		}
	}
}

export const listenerCount = (): number => listeners.size;
