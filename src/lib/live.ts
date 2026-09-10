// Browser side of the live view: an event stream from the worker for the servers on the page,
// with a slow safety poll behind it. The stream is closed while the tab is hidden (which also
// lets the server drop out of the watched tier) and reopened when it comes back.
import { api } from './api';
import type { LiveView } from './types';

export interface OutboxNotice {
	serverId: string;
	id: number;
	state: string;
}

const SAFETY_POLL_MS = 20_000;

export function watchLive(
	ids: string[],
	onLive: (v: LiveView) => void,
	onOutbox?: (n: OutboxNotice) => void
): () => void {
	if (!ids.length) return () => {};
	const query = `ids=${encodeURIComponent(ids.join(','))}`;
	let source: EventSource | null = null;
	let stopped = false;
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	const poll = async () => {
		if (stopped || document.hidden) return;
		try {
			const d = await api<{ live: Record<string, LiveView> }>('GET', `/api/live?${query}`);
			for (const v of Object.values(d.live)) onLive(v);
		} catch {
			/* the stream carries on */
		}
	};
	const open = () => {
		if (stopped || source) return;
		source = new EventSource(`/api/live/events?${query}`);
		source.addEventListener('live', (e) => onLive(JSON.parse((e as MessageEvent).data)));
		if (onOutbox)
			source.addEventListener('outbox', (e) => onOutbox(JSON.parse((e as MessageEvent).data)));
		// On error the browser reconnects by itself; the safety poll covers the gap.
	};
	const close = () => {
		source?.close();
		source = null;
	};
	const onVis = () => {
		if (document.hidden) close();
		else {
			open();
			void poll();
		}
	};
	if (!document.hidden) open();
	else void 0;
	pollTimer = setInterval(() => void poll(), SAFETY_POLL_MS);
	document.addEventListener('visibilitychange', onVis);
	return () => {
		stopped = true;
		close();
		clearInterval(pollTimer);
		document.removeEventListener('visibilitychange', onVis);
	};
}
