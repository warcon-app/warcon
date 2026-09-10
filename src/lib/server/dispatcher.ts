// One lane per game server: at most one request in flight per server, ordered by priority so a
// human's command never queues behind an observation or a trigger delivery. Everything that
// talks to a game server goes through here: observations, the delivery loop, the API, the
// org-list sync. Pure: no database, no game client (gateway-local.ts runs actions through it).

/** 0 = a person is waiting, 1 = trigger delivery, 2 = background observation */
export type Priority = 0 | 1 | 2;
export const PRIORITY = { command: 0 as const, delivery: 1 as const, observe: 2 as const };

/** How many jobs may wait for one server's lane before new ones are refused. */
export const MAX_QUEUED = 32;
/** A queued job that has waited longer than this is dropped instead of run late. */
export const DEFAULT_DEADLINE_MS = 30_000;

export class LaneFull extends Error {
	constructor(serverId: string) {
		super(`Too many requests are waiting for server ${serverId}; try again in a moment.`);
	}
}
export class LaneTimeout extends Error {
	constructor() {
		super('The request waited too long for the server and was dropped.');
	}
}

interface Job {
	priority: Priority;
	seq: number;
	deadline: number;
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

/**
 * Runs fn when the server's lane is free, ahead of anything with a lower priority. Refuses when
 * the lane is already full, and drops the job (rejecting with LaneTimeout) if it has waited past
 * its deadline by the time its turn comes, so a caller that gave up never has its command run late.
 */
export function withServer<T>(
	serverId: string,
	priority: Priority,
	fn: () => Promise<T>,
	deadlineMs = DEFAULT_DEADLINE_MS
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let lane = lanes.get(serverId);
		if (!lane) {
			lane = { running: false, jobs: [] };
			lanes.set(serverId, lane);
		}
		if (lane.jobs.length >= MAX_QUEUED) {
			reject(new LaneFull(serverId));
			return;
		}
		lane.jobs.push({
			priority,
			seq: seq++,
			deadline: Date.now() + deadlineMs,
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
	if (job.deadline < Date.now()) {
		job.reject(new LaneTimeout());
		pump(serverId, lane);
		return;
	}
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
