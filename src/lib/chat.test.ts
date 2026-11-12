import { describe, expect, test } from 'bun:test';
import { chatAfter, mergeChat, type ChatMessage } from './chat';

const line = (seq: number, sentUtc = `2026-11-12T15:00:0${seq % 10}.000Z`): ChatMessage => ({
	seq,
	sentUtc,
	channel: 'Team',
	faction: 'Valkyra',
	steamId: '76561198000000001',
	realName: 'Real',
	hiddenName: 'Pig',
	anonymous: false,
	text: `line ${seq}`,
	rawText: `line ${seq}`
});

describe('chatAfter', () => {
	test('asks from the start with nothing held', () => {
		expect(chatAfter([])).toBe(0);
	});
	test('asks from the line held last, so the answer starts with it again', () => {
		expect(chatAfter([line(1)])).toBe(0);
		expect(chatAfter([line(4), line(5)])).toBe(4);
	});
});

describe('mergeChat', () => {
	test('takes the whole answer when nothing is held', () => {
		expect(mergeChat([], { latestSeq: 2, messages: [line(1), line(2)] })).toEqual([
			line(1),
			line(2)
		]);
	});

	test('adds the new lines after the one it already held', () => {
		const held = [line(4), line(5)];
		const got = mergeChat(held, { latestSeq: 7, messages: [line(5), line(6), line(7)] });
		expect(got?.map((m) => m.seq)).toEqual([4, 5, 6, 7]);
	});

	test('keeps what it held when nothing is new', () => {
		const held = [line(4), line(5)];
		expect(mergeChat(held, { latestSeq: 5, messages: [line(5)] })).toBe(held);
	});

	test('a lower latestSeq is a new map: read again from the start', () => {
		expect(mergeChat([line(6), line(7)], { latestSeq: 2, messages: [] })).toBeNull();
	});

	test('a new map that got past the old count is caught by the line held last', () => {
		// The tab was hidden through a map change, and the new map reached seq 9 meanwhile.
		const held = [line(6), line(7)];
		const got = { latestSeq: 9, messages: [line(7, '2026-11-12T16:30:00.000Z'), line(8), line(9)] };
		expect(mergeChat(held, got)).toBeNull();
	});

	test('the line held last missing from the answer is a new map too', () => {
		expect(mergeChat([line(3)], { latestSeq: 3, messages: [] })).toBeNull();
	});
});
