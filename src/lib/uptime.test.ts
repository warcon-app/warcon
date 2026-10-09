import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_RESTART_SCHEDULE,
	describeRestartSchedule,
	fmtUptime,
	nextUtcAt,
	readManualRestart,
	restartScheduleOf,
	restartTimeFromConfig,
	restartWindow
} from './uptime';

const T0 = Date.parse('2026-09-14T00:00:00Z');
const H = 3600_000;
const ago = (hours: number) => new Date(T0 - hours * H).toISOString();

describe('restartWindow', () => {
	test('unknown start time is null', () => {
		expect(restartWindow(null, null, T0)).toBeNull();
		expect(restartWindow('', null, T0)).toBeNull();
		expect(restartWindow('not a date', null, T0)).toBeNull();
	});
	test('before 24 hours up: a window that opens later', () => {
		const w = restartWindow(ago(21), null, T0)!;
		expect(w.upMs).toBe(21 * H);
		expect(w.due).toBe(false);
		expect(w.untilDueMs).toBe(3 * H);
		expect(w.dueAt).toBe(T0 + 3 * H);
	});
	test('past 24 hours up: due, restarting after this round', () => {
		const w = restartWindow(ago(24.5), DEFAULT_RESTART_SCHEDULE, T0)!;
		expect(w.due).toBe(true);
		expect(w.untilDueMs).toBeNull();
		expect(w.upMs).toBe(24.5 * H);
	});
	test('exactly on the threshold counts as due', () => {
		expect(restartWindow(ago(24), null, T0)!.due).toBe(true);
	});
	test('a start time in the future (clock skew) reads as just started', () => {
		expect(restartWindow(new Date(T0 + 5000).toISOString(), null, T0)!.upMs).toBe(0);
	});
});

describe('restartWindow on a daily time', () => {
	const at = (iso: string) => Date.parse(iso);
	const daily = (time: string) => ({ kind: 'daily', time, source: 'config' }) as const;

	test('the window opens at the first HH:MM UTC after the process started', () => {
		const started = '2026-10-10T08:33:00Z';
		const before = restartWindow(started, daily('08:00'), at('2026-10-11T07:30:00Z'))!;
		expect(before.dueAt).toBe(at('2026-10-11T08:00:00Z'));
		expect(before.due).toBe(false);
		expect(before.untilDueMs).toBe(30 * 60_000);
		const after = restartWindow(started, daily('08:00'), at('2026-10-11T08:20:00Z'))!;
		expect(after.due).toBe(true);
		expect(after.untilDueMs).toBeNull();
	});
	test('a process started just before the time is due the same day', () => {
		const w = restartWindow('2026-10-10T07:58:00Z', daily('08:00'), at('2026-10-10T08:01:00Z'))!;
		expect(w.dueAt).toBe(at('2026-10-10T08:00:00Z'));
		expect(w.due).toBe(true);
	});
	test('midnight, and a start on the minute waits for the next day', () => {
		expect(nextUtcAt(at('2026-10-10T23:59:00Z'), '00:00')).toBe(at('2026-10-11T00:00:00Z'));
		expect(nextUtcAt(at('2026-10-10T08:00:00Z'), '08:00')).toBe(at('2026-10-11T08:00:00Z'));
		expect(nextUtcAt(at('2026-12-31T23:30:00Z'), '00:15')).toBe(at('2027-01-01T00:15:00Z'));
	});
});

describe('restartTimeFromConfig', () => {
	const doc = (...lines: string[]) => lines.join('\r\n');
	const SECTION = '[/Script/WDGame.WDServerLifecycleSubsystem]';

	test('reads RestartTimeUtc from its section, CRLF and all', () => {
		expect(
			restartTimeFromConfig(
				doc(
					'[/Script/WDGame.WDGameSession]',
					'ServerName=Test',
					'',
					SECTION,
					'RestartTimeUtc=08:00',
					''
				)
			)
		).toBe('08:00');
	});
	test('section and key in any case; one-digit hours; spaces and quotes', () => {
		expect(
			restartTimeFromConfig(
				doc('[/script/wdgame.wdserverlifecyclesubsystem]', 'restarttimeutc=0:00')
			)
		).toBe('00:00');
		expect(restartTimeFromConfig(doc(SECTION, 'RestartTimeUtc = 7:05 '))).toBe('07:05');
		expect(restartTimeFromConfig(doc(SECTION, 'RestartTimeUtc="23:59"'))).toBe('23:59');
	});
	test('a header and the key on one line is not the setting: the game strips it', () => {
		expect(restartTimeFromConfig(doc(`${SECTION} RestartTimeUtc=08:00`))).toBeNull();
		expect(
			restartTimeFromConfig(
				doc('[/Script/WDGame.WDGameSession]', 'ServerName=Test', `${SECTION} RestartTimeUtc=08:00`)
			)
		).toBeNull();
	});
	test('absent, elsewhere or not a time: not set', () => {
		for (const text of [
			'',
			doc('[/Script/WDGame.WDGameSession]', 'RestartTimeUtc=08:00'),
			doc(SECTION),
			doc(SECTION, 'RestartTimeUtc='),
			doc(SECTION, 'RestartTimeUtc=24:00'),
			doc(SECTION, 'RestartTimeUtc=08:60'),
			doc(SECTION, 'RestartTimeUtc=8'),
			doc(SECTION, 'RestartTimeUtc=08:00:00'),
			doc(SECTION, 'RestartTimeUtc=morning'),
			doc(SECTION, ';RestartTimeUtc=08:00')
		])
			expect(restartTimeFromConfig(text)).toBeNull();
	});
	test('only the time comes out of the document', () => {
		const text = doc(
			'[/Script/WDGame.WDRCONSettings]',
			'Password=hunter2-rcon',
			SECTION,
			'RestartTimeUtc=06:30'
		);
		expect(restartTimeFromConfig(text)).toBe('06:30');
	});
});

describe('readManualRestart', () => {
	test('a time from 00:00 to 23:59, nothing else kept', () => {
		expect(readManualRestart({ time: '00:00' })).toEqual({ time: '00:00' });
		expect(readManualRestart({ time: '23:59' })).toEqual({ time: '23:59' });
		expect(readManualRestart({ time: '07:00', timeZone: 'America/Chicago' })).toEqual({
			time: '07:00'
		});
	});
	test('refuses anything else', () => {
		for (const bad of [
			null,
			'07:00',
			[{ time: '07:00' }],
			{},
			{ time: '24:00' },
			{ time: '7:00' },
			{ time: '07:60' },
			{ time: ' 07:00' },
			{ time: '07:00:00' },
			{ time: 700 },
			{ kind: 'daily', time: '7am' }
		])
			expect(readManualRestart(bad)).toBeNull();
	});
});

describe('restartScheduleOf', () => {
	test("an owner's own time, else RestartTimeUtc in effect, else 24 hours up", () => {
		expect(restartScheduleOf({ time: '07:00' }, '08:00')).toEqual({
			kind: 'daily',
			time: '07:00',
			source: 'manual'
		});
		expect(restartScheduleOf(null, '08:00')).toEqual({
			kind: 'daily',
			time: '08:00',
			source: 'config'
		});
		expect(restartScheduleOf(null, null)).toEqual({ kind: 'uptime' });
		expect(restartScheduleOf(undefined, undefined)).toEqual(DEFAULT_RESTART_SCHEDULE);
	});
	test('a stored value that is not one falls through', () => {
		expect(restartScheduleOf({ time: '25:00' }, '08:00')).toEqual({
			kind: 'daily',
			time: '08:00',
			source: 'config'
		});
		expect(restartScheduleOf('07:00', 'soon')).toEqual({ kind: 'uptime' });
	});
	test('describes itself', () => {
		expect(describeRestartSchedule({ kind: 'uptime' })).toBe('after 24 hours up');
		expect(describeRestartSchedule(restartScheduleOf(null, '08:00'))).toBe(
			'daily at 08:00 UTC, from RestartTimeUtc in the config'
		);
		expect(describeRestartSchedule(restartScheduleOf({ time: '07:00' }, null))).toBe(
			'daily at 07:00 UTC, set on the Settings tab'
		);
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
