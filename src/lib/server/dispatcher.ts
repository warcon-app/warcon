// One lane per game server: at most one request in flight per server, ordered by priority so a
// human's command never queues behind an observation or a trigger delivery. Everything that
// talks to a game server goes through here: observations, the delivery loop, the API, the
// org-list sync. Pure: no database, no game client (gateway-local.ts runs actions through it).

/** 0 = a person is waiting, 1 = trigger delivery, 2 = background observation */
export type Priority = 0 | 1 | 2;
export const PRIORITY = { command: 0 as const, delivery: 1 as const, observe: 2 as const };

interface Job {
	priority: Priority;
	seq: number;
	run: () => Promise<unknown>;
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
}
interface Lane {
	running: boolean;
	jobs: Job[];
}

const lanes = new Map<string, Lane>();
let seq = 0;

/** Runs fn when the server's lane is free, ahead of anything with a lower priority. */
export function withServer<T>(
	serverId: string,
	priority: Priority,
	fn: () => Promise<T>
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let lane = lanes.get(serverId);
		if (!lane) {
			lane = { running: false, jobs: [] };
			lanes.set(serverId, lane);
		}
		lane.jobs.push({
			priority,
			seq: seq++,
			run: fn,
			resolve: resolve as (v: unknown) => void,
			reject
		});
		pump(serverId, lane);
	});
}

function pump(serverId: string, lane: Lane): void {
	if (lane.running) return;
	if (!lane.jobs.length) {
		lanes.delete(serverId);
		return;
	}
	let best = 0;
	for (let i = 1; i < lane.jobs.length; i++) {
		const a = lane.jobs[i];
		const b = lane.jobs[best];
		if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
	}
	const [job] = lane.jobs.splice(best, 1);
	lane.running = true;
	job
		.run()
		.then(job.resolve, job.reject)
		.finally(() => {
			lane.running = false;
			pump(serverId, lane);
		});
}

/** How many jobs are waiting for this server's lane. */
export function laneDepth(serverId: string): number {
	return lanes.get(serverId)?.jobs.length ?? 0;
}

export function dispatcherStats(): { busy: number; queued: number } {
	let busy = 0;
	let queued = 0;
	for (const l of lanes.values()) {
		if (l.running) busy++;
		queued += l.jobs.length;
	}
	return { busy, queued };
}
