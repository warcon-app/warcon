// In-memory sliding-window limiter for the two endpoints that let a signed-in user make Warcon
// send arbitrary requests to a game server (connectivity test, raw action). Per process: with
// several replicas the effective limit is that many times higher, which is still enough to stop
// the panel being used as a fast scanner.
import { ApiError } from './http';

const windows = new Map<string, number[]>();
let sweepAt = 0;

/** Throws 429 once `key` has been seen more than `limit` times inside the last `windowMs`. */
export function assertRate(key: string, limit: number, windowMs: number): void {
	const now = Date.now();
	if (sweepAt <= now) {
		for (const [k, stamps] of windows)
			if (stamps[stamps.length - 1] <= now - windowMs) windows.delete(k);
		sweepAt = now + windowMs;
	}
	const stamps = (windows.get(key) ?? []).filter((t) => t > now - windowMs);
	if (stamps.length >= limit) {
		const retryIn = Math.ceil((stamps[0] + windowMs - now) / 1000);
		windows.set(key, stamps);
		throw new ApiError(
			429,
			`Too many requests; try again in ${retryIn} second${retryIn === 1 ? '' : 's'}.`,
			'rate_limited'
		);
	}
	stamps.push(now);
	windows.set(key, stamps);
}

/** Test-only: forget every window. */
export function resetRates(): void {
	windows.clear();
	sweepAt = 0;
}
