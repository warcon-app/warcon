// The Live server name rule's settings, the state its row keeps and when the worker writes. The
// write itself is live-name-write.ts. At the worker's look at a server with the rule on, the name it
// should carry ($lib/live-name: its own name with the live part appended) goes into the config
// document's ServerName, which the game applies at once, whenever the name the server shows
// differs: at most once a minute, and the same name again at most every ten minutes, in case the
// server shows a name otherwise than it was written. Switched off or deleted, the rule's own name
// goes back the same way, from what the worker remembers (a worker that restarts in between has
// forgotten it). No outbox row and no audit row per write, which would come every minute a match is
// on: the rule keeps the name it last wrote and when, or a fixed phrase for why it could not.
import { ApiError } from './http';
import {
	LIVE_NAME_APPEND_DEFAULT,
	LIVE_NAME_APPEND_MAX,
	LIVE_NAME_MAX,
	oneLine,
	type LiveNameConfig
} from '../live-name';

/** The fewest milliseconds between two writes, and between two writes of the same name. */
export const LIVE_NAME_EVERY_MS = 60_000;
export const LIVE_NAME_SAME_MS = 10 * 60_000;

const upTo = (text: string, max: number) => Array.from(oneLine(text)).slice(0, max).join('').trim();

export function validateLiveName(raw: unknown): LiveNameConfig {
	const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const base = upTo(String(c.base ?? ''), LIVE_NAME_MAX);
	if (!base)
		throw new ApiError(
			400,
			"Give the server's own name: the live part is appended to it, and it goes back to it when the rule is off."
		);
	const append = upTo(String(c.append ?? LIVE_NAME_APPEND_DEFAULT), LIVE_NAME_APPEND_MAX);
	if (!append) throw new ApiError(400, 'Say what to append, such as | {scoreline}.');
	return { base, append };
}

/** What the rule's row keeps: the name it last wrote and when, and why the latest try wrote nothing. */
export interface LiveNameState {
	name: string;
	/** ms since the epoch; 0 until a name was written */
	at: number;
	/** a fixed phrase, '' when the latest try wrote the name */
	refused: string;
	/** when the tries began to fail (ms) */
	since: number;
	/** the rule's own name was put back once it was switched off */
	restored: boolean;
}

export function liveNameState(v: unknown): LiveNameState | null {
	if (!v || typeof v !== 'object') return null;
	const s = v as Record<string, unknown>;
	const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
	return {
		name: typeof s.name === 'string' ? s.name : '',
		at: n(s.at),
		refused: typeof s.refused === 'string' ? s.refused : '',
		since: n(s.since),
		restored: s.restored === true
	};
}

/** What the worker remembers of a server's rule between looks. */
export interface NameMemory {
	/** the rule last seen on, and its own name, which goes back once it is off */
	ruleId: string;
	base: string;
	attemptAt: number;
	/** the last name this process wrote, and when */
	written: string;
	writtenAt: number;
	/** the phrase last recorded for a failed try */
	refused: string;
}

/** Whether to write `want` at this look, the server showing `shown`. */
export function nameDue(mem: NameMemory, want: string, shown: string, now: number): boolean {
	if (!want || want === shown || now - mem.attemptAt < LIVE_NAME_EVERY_MS) return false;
	return want !== mem.written || now - mem.writtenAt >= LIVE_NAME_SAME_MS;
}
