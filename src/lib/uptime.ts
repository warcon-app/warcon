// How long the game process has been up, and where that sits against the server's next restart.
// WARDOGS does not restart on the mark: the restart happens when the round in progress ends. So
// once the time passes the server is "restarting after this round", and before it there is a
// window that opens in so many minutes. The worker derives `startedAt` from `uptimeSeconds` on
// GET /v1/health; the header, the status cards and the rules read this.
//
// When the restart comes, in order (restartScheduleOf):
// - an owner's own time, set on the Settings tab: daily at HH:MM UTC (`servers.restart_schedule`);
// - the game's own daily time, `RestartTimeUtc=HH:MM` (UTC) in the config document's
//   [/Script/WDGame.WDServerLifecycleSubsystem] section, as the running process read it when it
//   started (the setting takes effect at the next restart; `server_live.restart_time_utc`);
// - else the game's default: once the process has been up 24 hours.
import { getScalar, parseIni } from './config-doc';

/** Hours of uptime after which WARDOGS restarts a server that has no daily time. Fixed in the game. */
export const RESTART_AFTER_HOURS = 24;

/** The longest a restart notice's heads-up may lead by: just under a cycle. */
export const MAX_RESTART_LEAD_MINUTES = RESTART_AFTER_HOURS * 60 - 1;

/** What a server's next restart is reckoned from; `time` is "HH:MM" UTC. */
export type RestartSchedule =
	{ kind: 'uptime' } | { kind: 'daily'; time: string; source: 'config' | 'manual' };

/** The game's default: 24 hours up. */
export const DEFAULT_RESTART_SCHEDULE: RestartSchedule = { kind: 'uptime' };

/** An owner's own restart time, as `servers.restart_schedule` holds it and the API takes it. */
export interface ManualRestart {
	/** "HH:MM", UTC */
	time: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** An owner's own time, checked: `{ time: "HH:MM" }` from 00:00 to 23:59; null for anything else. */
export function readManualRestart(raw: unknown): ManualRestart | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const time = (raw as Record<string, unknown>).time;
	return typeof time === 'string' && TIME.test(time) ? { time } : null;
}

const S_LIFECYCLE = '/Script/WDGame.WDServerLifecycleSubsystem';
const RESTART_TIME_KEY = 'RestartTimeUtc';

/**
 * RestartTimeUtc in a config document, as "HH:MM"; null when the document does not set it, or not
 * as a time. Section and key match in any case, as the game reads them; a header and the key on
 * one line is a key of the section above, which the game strips, so it is not the setting.
 */
export function restartTimeFromConfig(text: string): string | null {
	const raw = getScalar(parseIni(text), S_LIFECYCLE, RESTART_TIME_KEY);
	const m = raw === null ? null : /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
	if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
	return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * The schedule a server runs on: an owner's own time, else RestartTimeUtc as the running process
 * read it, else 24 hours up.
 */
export function restartScheduleOf(
	manual: unknown,
	inEffect: string | null | undefined
): RestartSchedule {
	const own = readManualRestart(manual);
	if (own) return { kind: 'daily', time: own.time, source: 'manual' };
	if (inEffect && TIME.test(inEffect)) return { kind: 'daily', time: inEffect, source: 'config' };
	return DEFAULT_RESTART_SCHEDULE;
}

/** "after 24 hours up", "daily at 08:00 UTC, from RestartTimeUtc in the config", … */
export function describeRestartSchedule(s: RestartSchedule): string {
	if (s.kind === 'uptime') return `after ${RESTART_AFTER_HOURS} hours up`;
	return `daily at ${s.time} UTC, ${s.source === 'config' ? 'from RestartTimeUtc in the config' : 'set on the Settings tab'}`;
}

/** The first moment after `after` that the UTC clock reads `time`. */
export function nextUtcAt(after: number, time: string): number {
	const [hh, mm] = time.split(':').map(Number);
	const d = new Date(after);
	const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm);
	return at > after ? at : at + 24 * 3600_000;
}

export interface RestartWindow {
	/** milliseconds since the game process started */
	upMs: number;
	/** the time has passed: the server restarts when the current round ends */
	due: boolean;
	/** milliseconds until the time; null when due */
	untilDueMs: number | null;
	/** when the window opens for this game start (ms since the epoch) */
	dueAt: number;
}

/** Shown as "restart window in …" once the threshold is this close. */
export const RESTART_SOON_MS = 60 * 60_000;

/** null when the start time is unknown; no schedule is the game's default. */
export function restartWindow(
	startedAt: string | null | undefined,
	schedule: RestartSchedule | null | undefined,
	now: number
): RestartWindow | null {
	if (!startedAt) return null;
	const started = Date.parse(startedAt);
	if (!Number.isFinite(started)) return null;
	const upMs = Math.max(0, now - started);
	const s = schedule ?? DEFAULT_RESTART_SCHEDULE;
	const dueAt =
		s.kind === 'daily' ? nextUtcAt(started, s.time) : started + RESTART_AFTER_HOURS * 3600_000;
	const untilDueMs = dueAt - now;
	return untilDueMs <= 0
		? { upMs, due: true, untilDueMs: null, dueAt }
		: { upMs, due: false, untilDueMs, dueAt };
}

/** "3d 2h", "9h 12m", "12m", "<1m": the two largest units that are non-zero, minutes at least. */
export function fmtUptime(ms: number): string {
	const mins = Math.floor(Math.max(0, ms) / 60_000);
	if (mins < 1) return '<1m';
	const d = Math.floor(mins / 1440);
	const h = Math.floor((mins % 1440) / 60);
	const m = mins % 60;
	if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
	if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
	return `${m}m`;
}
