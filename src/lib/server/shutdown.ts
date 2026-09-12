// Coordinates a graceful stop of the web process. adapter-node handles SIGTERM by closing the
// HTTP server and waiting for every connection to end, which a long-lived event stream would
// hold open until its 30 s cut-off; so on the signal we end those streams ourselves (browsers
// reconnect, and during a rolling deploy they land on the new container), and once the server
// reports closed we release the rest and exit.

const hooks = new Set<() => void>();
let stopping = false;

/** True once a stop signal arrived; new long-lived work should be refused. */
export const isShuttingDown = () => stopping;

/** Runs `fn` when the process is asked to stop; returns a function that unregisters it. */
export function onShutdown(fn: () => void): () => void {
	hooks.add(fn);
	return () => hooks.delete(fn);
}

/** Marks the process as stopping and runs every registered hook once. */
export function beginShutdown(): void {
	if (stopping) return;
	stopping = true;
	for (const fn of [...hooks]) {
		hooks.delete(fn);
		try {
			fn();
		} catch {
			/* a stream that is already gone */
		}
	}
}
