import { describe, expect, test } from 'bun:test';
import { laneDepth, PRIORITY, withServer } from './dispatcher';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('withServer', () => {
	test('runs one job per server at a time, higher priority first', async () => {
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const first = withServer('s1', PRIORITY.observe, async () => {
			order.push('observe-1');
			await gate;
		});
		await tick();
		const later = withServer('s1', PRIORITY.observe, async () => void order.push('observe-2'));
		const cmd = withServer('s1', PRIORITY.command, async () => void order.push('command'));
		const delivery = withServer('s1', PRIORITY.delivery, async () => void order.push('delivery'));
		expect(laneDepth('s1')).toBe(3);
		release();
		await Promise.all([first, later, cmd, delivery]);
		expect(order).toEqual(['observe-1', 'command', 'delivery', 'observe-2']);
		expect(laneDepth('s1')).toBe(0);
	});

	test('different servers do not wait for each other', async () => {
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const a = withServer('a', PRIORITY.observe, async () => {
			await gate;
			order.push('a');
		});
		const b = withServer('b', PRIORITY.observe, async () => void order.push('b'));
		await b;
		expect(order).toEqual(['b']);
		release();
		await a;
	});

	test('a failing job releases the lane and rejects its caller only', async () => {
		await expect(
			withServer('c', PRIORITY.command, async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(await withServer('c', PRIORITY.command, async () => 'next')).toBe('next');
	});
});
