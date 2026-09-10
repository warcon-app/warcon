import { describe, expect, test } from 'bun:test';
import { nextDue, offlineLimit, phaseOffset, pickDue, type Slot } from './poller-schedule';

const slot = (id: string, dueAt: number | null, extra: Partial<Slot> = {}): Slot => ({
	id,
	dueAt,
	inFlight: false,
	offline: false,
	...extra
});

describe('phaseOffset', () => {
	test('is stable and within the interval', () => {
		expect(phaseOffset('srv_a', 20_000)).toBe(phaseOffset('srv_a', 20_000));
		for (const id of ['a', 'b', 'srv_123', 'x'.repeat(40)]) {
			const o = phaseOffset(id, 20_000);
			expect(o).toBeGreaterThanOrEqual(0);
			expect(o).toBeLessThan(20_000);
		}
		expect(phaseOffset('anything', 0)).toBe(0);
	});

	test('spreads many servers across the interval', () => {
		const buckets = new Array(10).fill(0);
		for (let i = 0; i < 1000; i++) buckets[Math.floor(phaseOffset(`server-${i}`, 10_000) / 1000)]++;
		for (const n of buckets) expect(n).toBeGreaterThan(50);
	});
});

describe('nextDue', () => {
	test('keeps a fixed cadence when on time', () => {
		expect(nextDue(10_000, 5_000, 10_200)).toBe(15_000);
	});
	test('does not burst to catch up after falling behind', () => {
		expect(nextDue(10_000, 5_000, 31_000)).toBe(36_000);
	});
});

describe('pickDue', () => {
	const budget = { total: 4, active: 0, offlineActive: 0, offlineShare: 0.5 };

	test('launches only servers that are due and idle, most overdue first', () => {
		const picked = pickDue(
			[
				slot('late', 100),
				slot('later', 50),
				slot('future', 5_000),
				slot('unscheduled', null),
				slot('running', 10, { inFlight: true })
			],
			1_000,
			budget
		);
		expect(picked.map((s) => s.id)).toEqual(['later', 'late']);
	});

	test('respects the free slots', () => {
		const slots = Array.from({ length: 10 }, (_, i) => slot(`s${i}`, i));
		expect(pickDue(slots, 100, { ...budget, active: 3 })).toHaveLength(1);
		expect(pickDue(slots, 100, { ...budget, active: 4 })).toHaveLength(0);
	});

	test('offline servers never take more than their share, online ones still run', () => {
		const offline = Array.from({ length: 6 }, (_, i) => slot(`off${i}`, i, { offline: true }));
		const online = [slot('on1', 50), slot('on2', 60)];
		const picked = pickDue([...offline, ...online], 100, budget);
		// budget 4, offline limit 2: two offline, then the two online servers behind them
		expect(picked.map((s) => s.id)).toEqual(['off0', 'off1', 'on1', 'on2']);
	});

	test('offline share already spent leaves every slot to online servers', () => {
		const picked = pickDue([slot('off', 1, { offline: true }), slot('on', 2)], 100, {
			...budget,
			active: 2,
			offlineActive: 2
		});
		expect(picked.map((s) => s.id)).toEqual(['on']);
	});

	test('offline limit is at least one slot', () => {
		expect(offlineLimit({ total: 1, offlineShare: 0.5 })).toBe(1);
		expect(offlineLimit({ total: 128, offlineShare: 0.5 })).toBe(64);
	});
});
