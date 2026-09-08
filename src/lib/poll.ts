/** Runs fn now and every `ms` while mounted (pausing in hidden tabs); returns a stop function for $effect cleanup. */
export function poll(fn: () => unknown, ms: number): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const tick = async () => {
		if (stopped) return;
		if (!document.hidden) {
			try {
				await fn();
			} catch (err) {
				console.warn('poll', err);
			}
		}
		if (!stopped) timer = setTimeout(tick, ms);
	};
	// Deferred so the first run is not part of the calling $effect's dependency tracking.
	timer = setTimeout(tick, 0);
	const onVis = () => {
		if (!document.hidden && !stopped) {
			clearTimeout(timer);
			void tick();
		}
	};
	document.addEventListener('visibilitychange', onVis);
	return () => {
		stopped = true;
		clearTimeout(timer);
		document.removeEventListener('visibilitychange', onVis);
	};
}
