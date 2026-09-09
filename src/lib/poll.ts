/** Runs fn now and every `ms` while mounted (pausing in hidden tabs); returns a stop function for $effect cleanup. */
export function poll(fn: () => unknown, ms: number): () => void {
	let stopped = false;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const tick = async () => {
		// One chain only: a visibility change while fn() is in flight must not start a second
		// tick, or both would keep rescheduling and the page would poll at twice the rate.
		if (stopped || running) return;
		clearTimeout(timer);
		if (!document.hidden) {
			running = true;
			try {
				await fn();
			} catch (err) {
				console.warn('poll', err);
			} finally {
				running = false;
			}
		}
		if (!stopped) timer = setTimeout(tick, ms);
	};
	// Deferred so the first run is not part of the calling $effect's dependency tracking.
	timer = setTimeout(tick, 0);
	const onVis = () => {
		if (!document.hidden && !stopped) void tick();
	};
	document.addEventListener('visibilitychange', onVis);
	return () => {
		stopped = true;
		clearTimeout(timer);
		document.removeEventListener('visibilitychange', onVis);
	};
}
