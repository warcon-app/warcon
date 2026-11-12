// The panel's reading of Season 3's chat routes: the terms and the lines kept to their known
// fields, whatever else an answer carries, and what is not an answer at all read as nothing.
import { describe, expect, test } from 'bun:test';
import {
	CHAT_KEEP,
	CHAT_PAGE,
	chatReadOf,
	chatTermsOf,
	shownName,
	takeRead,
	termsBlocks,
	type ChatHeld,
	type ChatLine,
	type ChatRead
} from './chat-read';

/** A line as the official console's notes give it. */
const LINE = {
	seq: 7,
	sentUtc: '2026-11-12T14:00:05.000Z',
	channel: 'Global',
	faction: 'RED',
	steamId: '76561198100000102',
	realName: 'Mad Marmalade',
	hiddenName: 'Quiet Badger',
	anonymous: true,
	text: 'what the **** is that tank doing',
	rawText: 'what the hell is that tank doing',
	ping: false
};

describe('chatTermsOf', () => {
	test('keeps the four fields', () => {
		expect(
			chatTermsOf({
				requiredVersion: 1,
				acceptedVersion: 0,
				accepted: false,
				text: 'Read these terms.\r\n- one\r\n- two',
				extra: 'not kept'
			})
		).toEqual({
			requiredVersion: 1,
			acceptedVersion: 0,
			accepted: false,
			text: 'Read these terms.\n- one\n- two',
			cut: false
		});
	});

	test('accepted is the game’s word, or what the versions say when it gives none', () => {
		const of = (o: Record<string, unknown>) => chatTermsOf({ text: '', ...o })!.accepted;
		expect(of({ requiredVersion: 2, acceptedVersion: 2, accepted: true })).toBe(true);
		expect(of({ requiredVersion: 2, acceptedVersion: 1, accepted: false })).toBe(false);
		// an answer that says accepted while an older version is the one on record is taken at its word
		expect(of({ requiredVersion: 2, acceptedVersion: 1, accepted: true })).toBe(true);
		expect(of({ requiredVersion: 2, acceptedVersion: 2 })).toBe(true);
		expect(of({ requiredVersion: 2, acceptedVersion: 1 })).toBe(false);
		expect(of({ requiredVersion: 2 })).toBe(false);
		expect(of({ requiredVersion: 1, acceptedVersion: 1, accepted: 'yes' })).toBe(true);
	});

	test('anything that names no version to accept is not a terms answer', () => {
		for (const raw of [null, undefined, 'x', 3, [], {}, { accepted: true }])
			expect(chatTermsOf(raw)).toBeNull();
		expect(chatTermsOf({ requiredVersion: '1' })).toBeNull();
		expect(chatTermsOf({ requiredVersion: 1.5 })).toBeNull();
		expect(chatTermsOf({ requiredVersion: -1 })).toBeNull();
	});

	test('a server that asks for no version is taken at its word', () => {
		expect(chatTermsOf({ requiredVersion: 0 })).toEqual({
			requiredVersion: 0,
			acceptedVersion: 0,
			accepted: true,
			text: '',
			cut: false
		});
		expect(chatTermsOf({ requiredVersion: 0, accepted: false })!.accepted).toBe(false);
	});

	test('the text is text: its control characters gone, its line breaks kept', () => {
		const terms = chatTermsOf({
			requiredVersion: 1,
			text: `one${String.fromCharCode(0)}${String.fromCharCode(27)}[31m\ttwo\n\n- three`
		})!;
		expect(terms.text).toBe('one[31mtwo\n\n- three');
		expect(chatTermsOf({ requiredVersion: 1, text: 42 })!.text).toBe('');
	});

	test('terms longer than the panel keeps are marked as cut, never passed off as whole', () => {
		const whole = chatTermsOf({ requiredVersion: 1, text: 'x'.repeat(20_000) })!;
		expect([whole.text.length, whole.cut]).toEqual([20_000, false]);
		const long = chatTermsOf({ requiredVersion: 1, text: 'x'.repeat(20_001) })!;
		expect([long.text.length, long.cut]).toEqual([20_000, true]);
	});
});

describe('chatReadOf', () => {
	test('keeps a line to its fields, oldest first', () => {
		const read = chatReadOf({
			latestSeq: 8,
			count: 2,
			messages: [
				{ ...LINE, seq: 8, anonymous: false, rawText: LINE.text, ping: true, more: 1 },
				LINE
			]
		})!;
		expect(read.latestSeq).toBe(8);
		expect(read.lines).toEqual([
			{
				seq: 7,
				at: '2026-11-12T14:00:05.000Z',
				channel: 'Global',
				faction: 'RED',
				steamId: '76561198100000102',
				name: 'Mad Marmalade',
				hiddenName: 'Quiet Badger',
				anonymous: true,
				text: 'what the **** is that tank doing',
				typed: 'what the hell is that tank doing',
				ping: false
			},
			{
				seq: 8,
				at: '2026-11-12T14:00:05.000Z',
				channel: 'Global',
				faction: 'RED',
				steamId: '76561198100000102',
				name: 'Mad Marmalade',
				hiddenName: 'Quiet Badger',
				anonymous: false,
				text: 'what the **** is that tank doing',
				// typed as it was shown: the filter changed nothing
				typed: null,
				ping: true
			}
		]);
	});

	test('odd values come out as nothing rather than as what they claim', () => {
		const [l] = chatReadOf({
			messages: [
				{
					seq: 3,
					sentUtc: 'yesterday',
					channel: 'Team<script>',
					faction: 7,
					steamId: 76561198100000102,
					realName: `Line${String.fromCharCode(10)}Break${String.fromCharCode(0)}`,
					hiddenName: null,
					anonymous: 'true',
					text: `${'a'.repeat(600)}`,
					rawText: null,
					ping: 1
				}
			]
		})!.lines;
		expect(l).toEqual({
			seq: 3,
			at: null,
			// text, shown as text: nothing here is markup
			channel: 'Team<script>',
			faction: '',
			steamId: '',
			name: 'Line Break',
			hiddenName: '',
			anonymous: false,
			text: 'a'.repeat(500),
			typed: null,
			ping: false
		});
	});

	test('a player with no platform id, and a list longer than the game gives', () => {
		const none = chatReadOf({ messages: [{ ...LINE, steamId: null }] })!.lines[0];
		expect(none.steamId).toBe('');
		const many = chatReadOf({
			latestSeq: 3,
			messages: Array.from({ length: 700 }, (_, i) => ({ ...LINE, seq: i + 1 }))
		})!;
		expect(many.lines).toHaveLength(500);
		// the answer's own number is passed on as given, behind its lines or not
		expect(many.latestSeq).toBe(3);
	});

	test('the newest number is the game’s own word, or nothing', () => {
		const of = (latestSeq: unknown) => chatReadOf({ latestSeq, messages: [LINE] })!.latestSeq;
		expect(of(7)).toBe(7);
		expect(of(0)).toBe(0);
		for (const none of [undefined, null, '7', 7.5, -1]) expect(of(none)).toBeNull();
	});

	test('a number is a number or its digits, and each is kept once', () => {
		const read = chatReadOf({
			messages: [
				{ ...LINE, seq: '9', text: 'nine' },
				{ ...LINE, seq: 8, text: 'eight' },
				{ ...LINE, seq: 8, text: 'eight again' },
				{ ...LINE, seq: '08x' },
				{ ...LINE, seq: '' }
			]
		})!;
		expect(read.lines.map((l) => [l.seq, l.text])).toEqual([
			[8, 'eight'],
			[9, 'nine']
		]);
	});

	test('lines with no number are left out; what is not a read is null', () => {
		const read = chatReadOf({
			latestSeq: 2,
			messages: [null, 'x', { ...LINE, seq: 0 }, { ...LINE, seq: -1 }, { ...LINE, seq: 2 }]
		})!;
		expect(read.lines.map((l) => l.seq)).toEqual([2]);
		expect(chatReadOf({ latestSeq: 5, messages: [] })).toEqual({ latestSeq: 5, lines: [] });
		expect(chatReadOf({ messages: [] })).toEqual({ latestSeq: null, lines: [] });
		// its newest line numbered and no list: nothing new
		expect(chatReadOf({ latestSeq: 3 })).toEqual({ latestSeq: 3, lines: [] });
		expect(chatReadOf({ latestSeq: 3, messages: null, count: 0 })).toEqual({
			latestSeq: 3,
			lines: []
		});
		for (const raw of [null, 'x', [], {}, { messages: 'none' }, { latestSeq: 3, messages: 'none' }])
			expect(chatReadOf(raw)).toBeNull();
		// a list with entries and not one line among them is some other answer, not a quiet chat
		expect(chatReadOf({ latestSeq: 2, messages: [{ id: 1 }, { id: 2 }] })).toBeNull();
		expect(chatReadOf({ messages: [{ ...LINE, seq: 'seven' }] })).toBeNull();
	});

	test('a channel is kept as the game names it, as one short line of text', () => {
		const channel = (v: unknown) =>
			chatReadOf({ messages: [{ ...LINE, channel: v }] })!.lines[0].channel;
		expect(channel('Squad 2')).toBe('Squad 2');
		expect(channel('小队')).toBe('小队');
		expect(channel(`Team${String.fromCharCode(10)}Chat`)).toBe('Team Chat');
		expect(channel('x'.repeat(40))).toBe('x'.repeat(24));
		expect(channel(null)).toBe('');
	});
});

describe('takeRead', () => {
	const line = (seq: number): ChatLine => ({
		seq,
		at: null,
		channel: 'Team',
		faction: 'RED',
		steamId: '',
		name: `p${seq}`,
		hiddenName: '',
		anonymous: false,
		text: `line ${seq}`,
		typed: null,
		ping: false
	});
	const read = (latestSeq: number | null, ...seqs: number[]): ChatRead => ({
		latestSeq,
		lines: seqs.map(line)
	});
	const held = (...seqs: number[]): ChatHeld => ({ lines: seqs.map(line), latest: seqs[0] ?? 0 });
	const seqs = (h: ChatHeld) => h.lines.map((l) => l.seq);

	test('new lines go on top, newest first, and move the number on', () => {
		const next = takeRead(held(3, 2, 1), read(5, 4, 5));
		expect(seqs(next)).toEqual([5, 4, 3, 2, 1]);
		expect([next.latest, next.restarted, next.more]).toEqual([5, false, false]);
	});

	test('a quiet read changes nothing, whatever number the game gives with it or not', () => {
		const have = held(3, 2, 1);
		for (const quiet of [read(3), read(null), read(9)]) {
			const next = takeRead(have, quiet);
			expect(next.lines).toBe(have.lines);
			expect([next.latest, next.restarted, next.more]).toEqual([3, false, false]);
		}
	});

	test('lines it already has are not taken twice, nor asked for again', () => {
		// a game that ignores `after` and sends its whole list each time
		const again = takeRead(held(3, 2, 1), read(3, 1, 2, 3), 3);
		expect(seqs(again)).toEqual([3, 2, 1]);
		expect(again.more).toBe(false);
		const some = takeRead(held(3, 2, 1), read(4, 2, 3, 4), 3);
		expect(seqs(some)).toEqual([4, 3, 2, 1]);
	});

	test('a full page of new lines says another may be waiting', () => {
		expect(takeRead(held(), read(3, 1, 2, 3), 3).more).toBe(true);
		expect(takeRead(held(), read(3, 1, 2), 3).more).toBe(false);
		expect(
			takeRead(held(), read(200, ...Array.from({ length: CHAT_PAGE }, (_, i) => i + 1))).more
		).toBe(true);
	});

	test('the game’s newest number below the last one read is a game that started again', () => {
		const next = takeRead(held(40, 39), read(2, 1, 2));
		expect([seqs(next), next.latest, next.restarted, next.more]).toEqual([[], 0, true, true]);
		// and the read made again from 0 is taken as a first one
		expect(seqs(takeRead(next, read(2, 1, 2)))).toEqual([2, 1]);
		// no number given is no such word: the lines after the last one read are simply taken
		expect(takeRead(held(40, 39), read(null, 41)).restarted).toBe(false);
		// an empty game after a restart says 0
		expect(takeRead(held(40), read(0)).restarted).toBe(true);
	});

	test('the tab holds so many lines and lets the oldest go', () => {
		const next = takeRead(held(3, 2, 1), read(6, 4, 5, 6), CHAT_PAGE, 4);
		expect(seqs(next)).toEqual([6, 5, 4, 3]);
		expect(CHAT_KEEP).toBe(1000);
	});
});

describe('on the page', () => {
	const line = (over: Partial<ChatLine>) =>
		({ name: 'Mad Marmalade', hiddenName: 'Quiet Badger', anonymous: false, ...over }) as ChatLine;

	test('the name shown is the one the other players saw', () => {
		expect(shownName(line({}))).toBe('Mad Marmalade');
		expect(shownName(line({ anonymous: true }))).toBe('Quiet Badger');
		// anonymous with no hidden name sent: the only name there is
		expect(shownName(line({ anonymous: true, hiddenName: '' }))).toBe('Mad Marmalade');
		expect(shownName(line({ name: '' }))).toBe('Quiet Badger');
		expect(shownName(line({ name: '', hiddenName: '' }))).toBe('Unknown');
	});

	test('the terms read as paragraphs and lists, and nothing in them is markup', () => {
		expect(termsBlocks('Read these.\n- one\n* two\n\n- three\nAfter <b>all</b>')).toEqual([
			{ p: 'Read these.' },
			{ ul: ['one', 'two'] },
			{ ul: ['three'] },
			{ p: 'After <b>all</b>' }
		]);
		expect(termsBlocks('')).toEqual([]);
	});
});
