import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_RESTART_SCHEDULE,
	describeRestartSchedule,
	fmtUptime,
	MAX_RESTART_HOURS,
	nextDailyAt,
	readRestartSchedule,
	restartScheduleOf,
	restartWindow
} from './uptime';

const T0 = Date.parse('2026-09-14T00:00:00Z');
const H = 3600_000;

describe('restartWindow', () => {
	test('unknown start time is null', () => {
		expect(restartWindow(null, 12, T0)).toBeNull();
		expect(restartWindow('', 12, T0)).toBeNull();
		expect(restartWindow('not a date', 12, T0)).toBeNull();
	});
	test('before the threshold: a window that opens later', () => {
		const w = restartWindow(new Date(T0 - 9 * H).toISOString(), 12, T0)!;
		expect(w.upMs).toBe(9 * H);
		expect(w.due).toBe(false);
		expect(w.untilDueMs).toBe(3 * H);
	});
	test('past the threshold: due, restarting after this round', () => {
		const w = restartWindow(new Date(T0 - 12.5 * H).toISOString(), 12, T0)!;
		expect(w.due).toBe(true);
		expect(w.untilDueMs).toBeNull();
		expect(w.upMs).toBe(12.5 * H);
	});
	test('exactly on the threshold counts as due', () => {
		expect(restartWindow(new Date(T0 - 12 * H).toISOString(), 12, T0)!.due).toBe(true);
	});
	test('no scheduled restart: uptime only', () => {
		const w = restartWindow(new Date(T0 - 30 * H).toISOString(), 0, T0)!;
		expect(w.due).toBe(false);
		expect(w.untilDueMs).toBeNull();
		expect(w.upMs).toBe(30 * H);
	});
	test('a start time in the future (clock skew) reads as just started', () => {
		expect(restartWindow(new Date(T0 + 5000).toISOString(), 12, T0)!.upMs).toBe(0);
	});
});

describe('restartWindow on a daily schedule', () => {
	// BisectHosting's daily restart, measured on a WARFORGE host 2026-09-23: 07:00 America/Chicago
	// (12:00 UTC in daylight time), the round then in progress finishing first.
	const daily = { kind: 'daily', time: '07:00', timeZone: 'America/Chicago' } as const;
	const at = (iso: string) => Date.parse(iso);

	test('the window opens at the next 07:00 after the game started, not 24 hours after it', () => {
		const started = '2026-09-22T19:04:00Z';
		const before = restartWindow(started, daily, at('2026-09-23T11:30:00Z'))!;
		expect(before.due).toBe(false);
		expect(before.dueAt).toBe(at('2026-09-23T12:00:00Z'));
		expect(before.untilDueMs).toBe(30 * 60_000);
		const after = restartWindow(started, daily, at('2026-09-23T12:39:00Z'))!;
		expect(after.due).toBe(true);
		expect(after.untilDueMs).toBeNull();
	});
	test('a game that starts after the time waits for the next day', () => {
		const w = restartWindow('2026-09-23T12:40:03Z', daily, at('2026-09-23T13:44:00Z'))!;
		expect(w.dueAt).toBe(at('2026-09-24T12:00:00Z'));
		expect(w.due).toBe(false);
	});
	test('a game started just before the time is due the same day', () => {
		const w = restartWindow('2026-09-23T11:58:00Z', daily, at('2026-09-23T12:01:00Z'))!;
		expect(w.dueAt).toBe(at('2026-09-23T12:00:00Z'));
		expect(w.due).toBe(true);
	});
	test('the time follows the zone across a DST change', () => {
		// US daylight time ends 2026-11-01: 07:00 Chicago is 13:00 UTC from then on
		const w = restartWindow('2026-10-31T13:00:00Z', daily, at('2026-10-31T14:00:00Z'))!;
		expect(w.dueAt).toBe(at('2026-11-01T13:00:00Z'));
	});
	test('a time the clock skips lands an hour later', () => {
		// 02:30 does not exist in Chicago on 2027-03-14; 03:30 CDT is 08:30 UTC
		const w = restartWindow(
			'2027-03-13T12:00:00Z',
			{ kind: 'daily', time: '02:30', timeZone: 'America/Chicago' },
			at('2027-03-13T13:00:00Z')
		)!;
		expect(w.dueAt).toBe(at('2027-03-14T08:30:00Z'));
	});
	test('an ambiguous time takes its first occurrence', () => {
		// 01:30 happens twice in Chicago on 2026-11-01; the first is 01:30 CDT, 06:30 UTC
		expect(nextDailyAt(at('2026-10-31T12:00:00Z'), '01:30', 'America/Chicago')).toBe(
			at('2026-11-01T06:30:00Z')
		);
	});
	test('UTC and zones east of it', () => {
		expect(nextDailyAt(at('2026-09-23T06:00:00Z'), '06:00', 'UTC')).toBe(
			at('2026-09-24T06:00:00Z')
		);
		expect(nextDailyAt(at('2026-09-23T01:00:00Z'), '04:00', 'Europe/Warsaw')).toBe(
			at('2026-09-23T02:00:00Z')
		);
	});
});

describe('restartWindow on other schedules', () => {
	test('an uptime schedule of its own replaces the default', () => {
		const w = restartWindow(
			new Date(T0 - 13 * H).toISOString(),
			{ kind: 'uptime', hours: 12 },
			T0
		)!;
		expect(w.due).toBe(true);
		expect(w.dueAt).toBe(T0 - H);
	});
	test('none: uptime only', () => {
		const w = restartWindow(new Date(T0 - 30 * H).toISOString(), { kind: 'none' }, T0)!;
		expect(w).toEqual({ upMs: 30 * H, due: false, untilDueMs: null, dueAt: null });
	});
	test('no schedule is the game default of 24 hours', () => {
		expect(restartWindow(new Date(T0 - 23 * H).toISOString(), null, T0)!.due).toBe(false);
		expect(restartWindow(new Date(T0 - 24 * H).toISOString(), undefined, T0)!.due).toBe(true);
	});
});

describe('readRestartSchedule', () => {
	test('accepts the three kinds', () => {
		expect(readRestartSchedule({ kind: 'none' })).toEqual({ kind: 'none' });
		expect(readRestartSchedule({ kind: 'uptime', hours: 12 })).toEqual({
			kind: 'uptime',
			hours: 12
		});
		expect(
			readRestartSchedule({ kind: 'daily', time: ' 07:00 ', timeZone: 'America/Chicago' })
		).toEqual({ kind: 'daily', time: '07:00', timeZone: 'America/Chicago' });
	});
	test('refuses anything else', () => {
		for (const bad of [
			null,
			'daily',
			{},
			{ kind: 'weekly' },
			{ kind: 'uptime', hours: 0 },
			{ kind: 'uptime', hours: 1.5 },
			{ kind: 'uptime', hours: MAX_RESTART_HOURS + 1 },
			{ kind: 'daily', time: '7:00', timeZone: 'UTC' },
			{ kind: 'daily', time: '24:00', timeZone: 'UTC' },
			{ kind: 'daily', time: '07:00', timeZone: 'Central' },
			{ kind: 'daily', time: '07:00' }
		])
			expect(readRestartSchedule(bad)).toBeNull();
	});
	test('a server without a valid schedule runs on the default', () => {
		expect(restartScheduleOf(null)).toEqual(DEFAULT_RESTART_SCHEDULE);
		expect(restartScheduleOf({ kind: 'uptime', hours: -3 })).toEqual(DEFAULT_RESTART_SCHEDULE);
	});
	test('describes itself', () => {
		expect(describeRestartSchedule({ kind: 'uptime', hours: 24 })).toBe('after 24 hours up');
		expect(describeRestartSchedule({ kind: 'uptime', hours: 1 })).toBe('after 1 hour up');
		expect(
			describeRestartSchedule({ kind: 'daily', time: '07:00', timeZone: 'America/Chicago' })
		).toBe('daily at 07:00 America/Chicago');
		expect(describeRestartSchedule({ kind: 'none' })).toBe('none');
	});
});

describe('fmtUptime', () => {
	test('units', () => {
		expect(fmtUptime(0)).toBe('<1m');
		expect(fmtUptime(59_000)).toBe('<1m');
		expect(fmtUptime(12 * 60_000)).toBe('12m');
		expect(fmtUptime(9 * H + 12 * 60_000)).toBe('9h 12m');
		expect(fmtUptime(9 * H)).toBe('9h');
		expect(fmtUptime(26 * H + 30 * 60_000)).toBe('1d 2h');
		expect(fmtUptime(48 * H)).toBe('2d');
	});
});
