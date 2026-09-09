import { afterEach, beforeEach, expect, test } from 'bun:test';
import { poll } from './poll';

type Doc = {
	hidden: boolean;
	addEventListener: (t: string, h: () => void) => void;
	removeEventListener: () => void;
};
let visHandler: (() => void) | null = null;
const saved = (globalThis as { document?: unknown }).document;

beforeEach(() => {
	const doc: Doc = {
		hidden: false,
		addEventListener: (_t, h) => (visHandler = h),
		removeEventListener: () => {}
	};
	(globalThis as { document?: unknown }).document = doc;
});
afterEach(() => {
	(globalThis as { document?: unknown }).document = saved;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a visibility change during an in-flight fn() does not start a second chain', async () => {
	let calls = 0;
	const stop = poll(async () => {
		calls++;
		await wait(40);
	}, 100);
	await wait(10); // first tick is inside fn()
	visHandler!();
	await wait(1000);
	stop();
	// One chain: roughly one call per 140ms (100ms interval + 40ms in flight); two chains would double it.
	expect(calls).toBeGreaterThanOrEqual(5);
	expect(calls).toBeLessThanOrEqual(9);
});

test('stop() ends the chain and a visibility change afterwards does nothing', async () => {
	let calls = 0;
	const stop = poll(() => void calls++, 20);
	await wait(60);
	stop();
	const seen = calls;
	visHandler!();
	await wait(80);
	expect(calls).toBe(seen);
});
