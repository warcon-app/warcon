// How long the game process has been up, and where that sits against the server's scheduled
// restart. WARDOGS restarts a server on a schedule, but not on the mark: the restart happens when
// the round in progress ends. So once the scheduled time passes the server is "restarting after
// this round", and before it there is a window that opens in so many minutes. The worker derives
// `startedAt` from `uptimeSeconds` on GET /v1/health; the header, the status cards and the
// Restart notice rule read this.
//
// What the schedule is depends on the host, so it is a per-server setting (`restart_schedule`):
// - uptime: once the process has been up so many hours (the game's own restart, 24 by default,
//   twelve before September 2026).
// - daily: at a time of day the host lets the owner pick (BisectHosting since September 2026),
//   in the host's time zone. The round then in progress still finishes first.
// - none: no scheduled restart; the uptime shows, nothing else.

/** Hours of uptime after which WARDOGS restarts a server that has no schedule of its own. */
export const RESTART_AFTER_HOURS = 24;

/** `daily`'s time is "HH:MM" on a 24-hour clock, its zone an IANA name such as America/Chicago. */
export type RestartSchedule =
	| { kind: 'uptime'; hours: number }
	| { kind: 'daily'; time: string; timeZone: string }
	| { kind: 'none' };

/** What a server with no `restart_schedule` of its own gets. */
export const DEFAULT_RESTART_SCHEDULE: RestartSchedule = {
	kind: 'uptime',
	hours: RESTART_AFTER_HOURS
};

/** The longest uptime schedule a server may set: a week. */
export const MAX_RESTART_HOURS = 168;

/** The longest a restart notice's heads-up may lead by: just under a day, the longest daily cycle. */
export const MAX_RESTART_LEAD_MINUTES = 24 * 60 - 1;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTimeZone(tz: string): boolean {
	if (!tz) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** A stored or submitted schedule, checked; null when it is missing or not a schedule. */
export function readRestartSchedule(raw: unknown): RestartSchedule | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (r.kind === 'none') return { kind: 'none' };
	if (r.kind === 'uptime') {
		const hours = Number(r.hours);
		return Number.isInteger(hours) && hours >= 1 && hours <= MAX_RESTART_HOURS
			? { kind: 'uptime', hours }
			: null;
	}
	if (r.kind === 'daily') {
		const time = typeof r.time === 'string' ? r.time.trim() : '';
		const timeZone = typeof r.timeZone === 'string' ? r.timeZone.trim() : '';
		return TIME.test(time) && isTimeZone(timeZone) ? { kind: 'daily', time, timeZone } : null;
	}
	return null;
}

/** The schedule a server runs on: its own, else the game's default. */
export const restartScheduleOf = (raw: unknown): RestartSchedule =>
	readRestartSchedule(raw) ?? DEFAULT_RESTART_SCHEDULE;

/** "after 24 hours up", "daily at 07:00 America/Chicago", "none". */
export function describeRestartSchedule(s: RestartSchedule): string {
	if (s.kind === 'uptime') return `after ${s.hours} hour${s.hours === 1 ? '' : 's'} up`;
	if (s.kind === 'daily') return `daily at ${s.time} ${s.timeZone}`;
	return 'none';
}

/** Milliseconds `timeZone` is ahead of UTC at the instant `at`. */
function zoneOffsetMs(timeZone: string, at: number): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric'
	}).formatToParts(at);
	const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const wall = Date.UTC(
		n('year'),
		n('month') - 1,
		n('day'),
		n('hour') % 24,
		n('minute'),
		n('second')
	);
	return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The first moment after `after` that the clock in `timeZone` reads `time`. A time that does not
 * exist on a spring-forward day lands an hour later, the way the clock itself skips it.
 */
export function nextDailyAt(after: number, time: string, timeZone: string): number {
	const [hh, mm] = time.split(':').map(Number);
	const local = new Date(after + zoneOffsetMs(timeZone, after));
	for (let day = 0; day <= 2; day++) {
		const wall = Date.UTC(
			local.getUTCFullYear(),
			local.getUTCMonth(),
			local.getUTCDate() + day,
			hh,
			mm
		);
		// The offset at the guess, then at the answer: when a DST change falls between them, the
		// answer with its own offset is the real one, and with neither (a skipped time) the later.
		let at = wall - zoneOffsetMs(timeZone, wall);
		const off = zoneOffsetMs(timeZone, at);
		if (wall - off !== at) {
			const alt = wall - off;
			at = zoneOffsetMs(timeZone, alt) === off ? alt : Math.max(at, alt);
		}
		if (at > after) return at;
	}
	// unreachable for a real zone: the time recurs within two days
	return after + 24 * 3600_000;
}

export interface RestartWindow {
	/** milliseconds since the game process started */
	upMs: number;
	/** the scheduled time has passed: the server restarts when the current round ends */
	due: boolean;
	/** milliseconds until the scheduled time; null when due, or when no restart is scheduled */
	untilDueMs: number | null;
	/** when the window opens (ms since the epoch) for this game start; null when none is scheduled */
	dueAt: number | null;
}

/** Shown as "restart window in …" once the threshold is this close. */
export const RESTART_SOON_MS = 60 * 60_000;

/**
 * null when the start time is unknown. `schedule` is the server's schedule; a number is hours of
 * uptime, 0 meaning no scheduled restart (tests), and null or undefined the game's default.
 */
export function restartWindow(
	startedAt: string | null | undefined,
	schedule: RestartSchedule | number | null | undefined,
	now: number
): RestartWindow | null {
	if (!startedAt) return null;
	const started = Date.parse(startedAt);
	if (!Number.isFinite(started)) return null;
	const upMs = Math.max(0, now - started);
	const s: RestartSchedule =
		typeof schedule === 'number'
			? schedule > 0
				? { kind: 'uptime', hours: schedule }
				: { kind: 'none' }
			: (schedule ?? DEFAULT_RESTART_SCHEDULE);
	const dueAt =
		s.kind === 'uptime'
			? started + s.hours * 3600_000
			: s.kind === 'daily'
				? nextDailyAt(started, s.time, s.timeZone)
				: null;
	if (dueAt === null) return { upMs, due: false, untilDueMs: null, dueAt: null };
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
