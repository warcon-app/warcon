import { describe, expect, test } from 'bun:test';
import {
	checkWelcome,
	closeWelcomeTags,
	escapeWelcome,
	formatWelcome,
	formatWelcomeLine,
	normaliseBreaks,
	parseWelcomeLine,
	plainWelcomeLine,
	previewWelcomeLine,
	refusedWelcome,
	splitWelcomeLines,
	straightenQuotes,
	visibleLength,
	WELCOME_LIMITS,
	welcomeLimitsOf,
	type WelcomeLimits
} from './welcome-text';

const L = WELCOME_LIMITS;
const said = (line: string, limits: WelcomeLimits = L) =>
	checkWelcome([line], limits).map((i) => `${i.level}: ${i.message}`);
const refusals = (line: string, limits: WelcomeLimits = L) =>
	refusedWelcome(checkWelcome([line], limits)).map((i) => i.message);
const runs = (line: string) =>
	parseWelcomeLine(line).map((r) => [r.kind, r.name, r.text] as [string, string, string]);

describe('the limits a status reports', () => {
	test('the five numbers of a Season 3 status are taken as they are', () => {
		expect(
			welcomeLimitsOf({
				maxLines: 128,
				maxLineLength: 128,
				minFontSize: 8,
				maxFontSize: 24,
				maxCloseDelaySeconds: 60
			})
		).toEqual(L);
		expect(
			welcomeLimitsOf({
				maxLines: 40,
				maxLineLength: 90,
				minFontSize: 10,
				maxFontSize: 18,
				maxCloseDelaySeconds: 15,
				somethingNew: true
			})
		).toEqual({
			maxLines: 40,
			maxLineLength: 90,
			minFontSize: 10,
			maxFontSize: 18,
			maxCloseDelaySeconds: 15
		});
	});
	test('a status without them, or with anything but whole numbers that fit together, gives none', () => {
		const good = { ...L };
		for (const raw of [
			undefined,
			null,
			'128',
			[],
			{},
			{ ...good, maxLines: '128' },
			{ ...good, maxLineLength: 12.5 },
			{ ...good, minFontSize: 0 },
			{ ...good, maxFontSize: 4 },
			{ ...good, maxCloseDelaySeconds: -1 },
			{ ...good, maxLines: Number.NaN },
			{ ...good, maxLines: 1e9 },
			{ maxLines: 128, maxLineLength: 128, minFontSize: 8, maxFontSize: 24 }
		])
			expect(welcomeLimitsOf(raw)).toBeNull();
	});
});

describe('a line as the game reads it', () => {
	test('the notes’ own examples: a style or a look around text, closed by </>', () => {
		expect(runs('<Header>Welcome to Dogpile</>')).toEqual([
			['style', 'Header', 'Welcome to Dogpile']
		]);
		expect(runs('<Bold>No cheating</>')).toEqual([['style', 'Bold', 'No cheating']]);
		expect(runs('<Italic>Have fun</>')).toEqual([['style', 'Italic', 'Have fun']]);
		const [look] = parseWelcomeLine(
			'<text color="#E8A33D" size="16" fontface="Bold">EU Hardcore KOTH</>'
		);
		expect([look.kind, look.text]).toEqual(['text', 'EU Hardcore KOTH']);
		expect(look.attributes).toEqual([
			{ key: 'color', value: '#E8A33D' },
			{ key: 'size', value: '16' },
			{ key: 'fontface', value: 'Bold' }
		]);
		expect(runs('Keep chat in <text color="#7FD6FF">English</> and be respectful')).toEqual([
			['plain', '', 'Keep chat in '],
			['text', 'text', 'English'],
			['plain', '', ' and be respectful']
		]);
		expect(said('<Header>Welcome to Dogpile</>')).toEqual([]);
		expect(said('Keep chat in <text color="#7FD6FF">English</> and be respectful')).toEqual([]);
		expect(said('<text size="20" fontface="Bold" color="#FF4D4D">SERVER RULES</>')).toEqual([]);
	});
	test('an empty line is a spacer with nothing on it', () => {
		expect(parseWelcomeLine('')).toEqual([]);
		expect(visibleLength('')).toBe(0);
		expect(said('')).toEqual([]);
	});
	test('tags do not count towards the length, and an entity counts as one', () => {
		expect(visibleLength('<Bold>No cheating</>')).toBe(11);
		expect(visibleLength('1 &lt; 2 &amp; 3 &gt; 2 &quot;q&quot;')).toBe(17);
		expect(runs('1 &lt; 2 &amp; 3 &gt; 2 &quot;q&quot;')).toEqual([
			['plain', '', '1 < 2 & 3 > 2 "q"']
		]);
		// read once: the entity of an ampersand does not start another
		expect(runs('&amp;lt;')).toEqual([['plain', '', '&lt;']]);
		expect(visibleLength('😀')).toBe(2);
	});
	test('a tag is a name, attributes after one space each with straight quotes, and </>', () => {
		// closed by name, two spaces, single quotes, no quotes: none of these is a tag
		for (const typed of [
			'<Bold>x</Bold>',
			'<text  color="#FF0000">x</>',
			"<text color='#FF0000'>x</>",
			'<text color=#FF0000>x</>',
			'<Bold>x',
			'< Bold>x</>'
		])
			expect(runs(typed)).toEqual([['plain', '', typed]]);
		// the content ends at the first </>, so a tag inside another is text, and its closer too
		expect(runs('<Bold><Italic>x</></>')).toEqual([
			['style', 'Bold', '<Italic>x'],
			['plain', '', '</>']
		]);
		expect(runs('<Bold/>after')).toEqual([
			['style', 'Bold', ''],
			['plain', '', 'after']
		]);
	});
	test('what the popup keeps: any tag without attributes, and <text> whatever its case', () => {
		expect(runs('<TEXT color="#FF0000">x</>')).toEqual([['text', 'TEXT', 'x']]);
		expect(runs('<Blod>x</>')).toEqual([['style', 'Blod', 'x']]);
		// anything else with attributes shows as typed, markup and all
		expect(runs('<a href="https://x.example">link</>')).toEqual([
			['literal', 'a', '<a href="https://x.example">link</>']
		]);
		expect(runs('<Header color="#FF0000">Rules</>')).toEqual([
			['literal', 'Header', '<Header color="#FF0000">Rules</>']
		]);
		expect(visibleLength('<a href="https://x.example">link</>')).toBe(35);
		expect(runs('<img id="x"/>')).toEqual([['literal', 'img', '<img id="x"/>']]);
	});
	test('attribute names take no hyphen, and a repeated one counts once, with its last value', () => {
		// read as color="#FFFFFF": the name is what stands before the = without a hyphen
		expect(parseWelcomeLine('<text data-color="#FFFFFF">x</>')[0].attributes).toEqual([
			{ key: 'color', value: '#FFFFFF' }
		]);
		// no attribute at all, so the style is kept
		expect(runs('<Bold -="x">hi</>')).toEqual([['style', 'Bold', 'hi']]);
		expect(parseWelcomeLine('<text size="30" size="16">x</>')[0].attributes).toEqual([
			{ key: 'size', value: '16' }
		]);
	});
});

describe('what the game refuses', () => {
	test('a line with more visible characters than the limit', () => {
		expect(refusals('x'.repeat(128))).toEqual([]);
		expect(refusals(`<Bold>${'x'.repeat(128)}</>`)).toEqual([]);
		expect(refusals('x'.repeat(129))).toEqual([
			'Line 1 has 129 visible characters, and the popup takes 128.'
		]);
		expect(refusals(`${'&lt;'.repeat(128)}`)).toEqual([]);
		expect(refusals(`${'&lt;'.repeat(129)}`)).toHaveLength(1);
	});
	test('more lines than the limit, and nothing is said of the lines past it', () => {
		const lines = [...Array.from({ length: 128 }, () => 'ok'), '<a href="x">y</>'];
		expect(checkWelcome(lines.slice(0, 128), L)).toEqual([]);
		expect(checkWelcome(lines, L)).toEqual([
			{ line: null, level: 'refused', message: 'The popup takes 128 lines, and this text has 129.' }
		]);
	});
	test('a tag with attributes that is not <text>: a link, an image, a coloured header', () => {
		expect(said('<a href="https://x.example">link</>')).toEqual([
			'refused: Line 1: <a> is not a tag the popup takes; only <text> has attributes.'
		]);
		expect(refusals('<Header color="#FF0000">Rules</>')[0]).toStartWith(
			'Line 1: <Header> takes no colour, size or font face.'
		);
		expect(checkWelcome(['<a href="x">y</>'], L)[0].fix).toBe('plain');
	});
	test('a <text> attribute that is not color, size or fontface', () => {
		expect(refusals('<text size="16" href="x">odd</>')).toEqual([
			'Line 1: <text> takes color, size and fontface, not href.'
		]);
		expect(refusals('<text Color="#FF0000" SIZE="12" FontFace="Italic">fine</>')).toEqual([]);
	});
	test('a size that is not a whole number in the server’s range, written plainly', () => {
		for (const ok of ['8', '16', '24']) expect(refusals(`<text size="${ok}">x</>`)).toEqual([]);
		for (const bad of ['7', '25', '016', '+16', ' 16', '16 ', '16.5', '16px', '', '-3', '1e1'])
			expect([bad, refusals(`<text size="${bad}">x</>`)]).toEqual([
				bad,
				[`Line 1: size="${bad}" is not a whole number from 8 to 24.`]
			]);
		const narrow = { ...L, minFontSize: 10, maxFontSize: 18 };
		expect(refusals('<text size="18">x</>', narrow)).toEqual([]);
		expect(refusals('<text size="8">x</>', narrow)).toEqual([
			'Line 1: size="8" is not a whole number from 10 to 18.'
		]);
		// of a repeated size the last counts
		expect(refusals('<text size="30" size="16">x</>')).toEqual([]);
		expect(refusals('<text size="16" size="30">x</>')).toHaveLength(1);
	});
	test('a line with a line break of another kind inside it', () => {
		expect(refusals('one\u2028two')).toEqual([
			'Line 1 has a line break inside it; each line of the popup is a line of its own.'
		]);
		expect(refusals('one\u000Ctwo')).toHaveLength(1);
	});
	test('each line is named by its place in the popup', () => {
		const issues = checkWelcome(['fine', '', '<a href="x">y</>', 'x'.repeat(200)], L);
		expect(issues.map((i) => [i.line, i.level])).toEqual([
			[3, 'refused'],
			[4, 'refused']
		]);
	});
});

describe('what the game takes and shows as typed', () => {
	test('a tag closed by name, as in HTML', () => {
		expect(said('<Bold>No cheating</Bold>')).toEqual([
			'typed: Line 1 shows </Bold> as typed: a tag is closed with </>, whatever its name.'
		]);
		expect(checkWelcome(['<Bold>No cheating</Bold>'], L)[0].fix).toBe('closers');
		expect(closeWelcomeTags('<Bold>No cheating</Bold> <text color="#FFFFFF">x</text>')).toBe(
			'<Bold>No cheating</> <text color="#FFFFFF">x</>'
		);
		expect(said(closeWelcomeTags('<Bold>No cheating</Bold>'))).toEqual([]);
	});
	test('a tag pasted from a chat message, its quotes curled', () => {
		const pasted = '<text color=“#E8A33D” size=“16" fontface=“Bold”>EU Hardcore KOTH</>';
		const [issue] = checkWelcome([pasted], L);
		expect([issue.level, issue.fix]).toEqual(['typed', 'quotes']);
		expect(issue.message).toContain('its quotes are curly');
		const fixed = straightenQuotes(pasted);
		expect(fixed).toBe('<text color="#E8A33D" size="16" fontface="Bold">EU Hardcore KOTH</>');
		expect(said(fixed)).toEqual([]);
		// quotes in the text itself are the writer's own
		expect(straightenQuotes('<Bold>“Dogpile”</> says “hi”')).toBe('<Bold>“Dogpile”</> says “hi”');
	});
	test('a tag inside another, and the closer it leaves behind', () => {
		expect(said('<Bold><Italic>both</></>')).toEqual([
			'typed: Line 1 shows <Italic> as typed: a tag cannot go inside another.'
		]);
		expect(said('fine</>')).toEqual([
			'typed: Line 1 shows </> as typed: no tag is open before it.'
		]);
	});
	test('a tag left open, or one the popup has no name for', () => {
		expect(said('<Bold>No cheating')).toEqual([
			'typed: Line 1 shows <Bold> as typed: it is not closed with </>, or is not a tag the popup takes.'
		]);
		expect(said('<Blod>typo</>')).toEqual([
			"typed: Line 1: <Blod> is not one of the popup's styles (Header, Bold, Italic)."
		]);
		for (const style of ['<header>x</>', '<BOLD>x</>', '<italic>x</>'])
			expect(said(style)).toEqual([]);
	});
	test('a colour that is not #RRGGBB, a font face that is not Bold or Italic', () => {
		expect(said('<text color="red">x</>')).toEqual([
			'typed: Line 1: color="red" is not a colour as #RRGGBB.'
		]);
		expect(said('<text color="#fff">x</>')).toHaveLength(1);
		expect(said('<text color="#FF4D4D80">x</>')).toEqual([]);
		expect(said('<text fontface="Heavy">x</>')).toEqual([
			'typed: Line 1: fontface="Heavy" is not Bold or Italic.'
		]);
		for (const face of ['Bold', 'italic', 'Regular'])
			expect(said(`<text fontface="${face}">x</>`)).toEqual([]);
	});
	test('a < that was never a tag is nobody’s mistake', () => {
		for (const line of ['I <3 this server', 'a < b > c', '2 > 1', '<< RULES >>', '-> go', '<3>'])
			expect([line, said(line)]).toEqual([line, []]);
	});
	test('one note for a line, the likeliest slip first; none of them stops an apply', () => {
		const issues = checkWelcome(['<Bold>a</Bold> <Italic>b</Italic>'], L);
		expect(issues).toHaveLength(1);
		expect(refusedWelcome(issues)).toEqual([]);
	});
});

describe('keeping what shows as typed', () => {
	test('a tag the popup does not keep is written as plain text, and reads the same', () => {
		const line = '<a href="x">link</> and <Bold>a <b> c</>';
		const plain = plainWelcomeLine(line);
		expect(plain).toBe('&lt;a href="x"&gt;link&lt;/&gt; and <Bold>a &lt;b&gt; c</>');
		expect(said(plain)).toEqual([]);
		expect(
			parseWelcomeLine(plain)
				.map((r) => r.text)
				.join('')
		).toBe(
			parseWelcomeLine(line)
				.map((r) => r.text)
				.join('')
		);
	});
	test('entities already written are left alone', () => {
		expect(plainWelcomeLine('1 &lt; 2 & <Bold>x</>')).toBe('1 &lt; 2 & <Bold>x</>');
		expect(escapeWelcome('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
	});
});

describe('the popup as a player sees it', () => {
	test('each style, and a look’s size, colour and face', () => {
		const plain = { header: false, bold: false, italic: false, color: '', size: null };
		expect(
			previewWelcomeLine(
				'a<Header>b</><Bold>c</><Italic>d</><text color="#7FD6FF" size="18" fontface="Italic">e</>',
				L
			)
		).toEqual({
			cut: false,
			runs: [
				{ ...plain, text: 'a' },
				{ ...plain, text: 'b', header: true, bold: true },
				{ ...plain, text: 'c', bold: true },
				{ ...plain, text: 'd', italic: true },
				{ ...plain, text: 'e', italic: true, color: '#7FD6FF', size: 18 }
			]
		});
	});
	test('a size is held to the server’s range, as the game holds it', () => {
		const size = (v: string) => previewWelcomeLine(`<text size="${v}">x</>`, L).runs[0].size;
		expect([size('30'), size('2'), size('abc'), size('16.9'), size(' 12')]).toEqual([
			24, 8, 8, 16, 12
		]);
	});
	test('only a colour written as hex reaches the page', () => {
		const colour = (v: string) => previewWelcomeLine(`<text color="${v}">x</>`, L).runs[0].color;
		expect(colour('#FF4D4D')).toBe('#FF4D4D');
		expect(colour('#FF4D4D80')).toBe('#FF4D4D80');
		for (const v of ['red', '#fff', 'url(x)', '#FF4D4D;background:url(x)', 'expression(1)'])
			expect(colour(v)).toBe('');
	});
	test('a tag the popup does not keep, and a style it has no name for, are drawn plain', () => {
		expect(previewWelcomeLine('<a href="x">y</>', L).runs).toEqual([
			{ text: '<a href="x">y</>', header: false, bold: false, italic: false, color: '', size: null }
		]);
		expect(previewWelcomeLine('<Blod>y</>', L).runs[0]).toMatchObject({ text: 'y', bold: false });
	});
	test('a line is cut after the limit of visible characters', () => {
		const short = { ...L, maxLineLength: 5 };
		expect(previewWelcomeLine('<Bold>abc</>defgh', short)).toMatchObject({
			cut: true,
			runs: [{ text: 'abc' }, { text: 'de' }]
		});
		expect(previewWelcomeLine('<Bold>abc</>de', short).cut).toBe(false);
		expect(previewWelcomeLine('', L)).toEqual({ runs: [], cut: false });
	});
});

describe('the text box', () => {
	test('one line of the box is one of the popup; the empty lines at the end are not', () => {
		expect(splitWelcomeLines('')).toEqual([]);
		expect(splitWelcomeLines('a\n\nb\n\n')).toEqual(['a', '', 'b']);
		expect(splitWelcomeLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
	});
	test('every kind of line break is the one a text box keeps', () => {
		expect(normaliseBreaks('a\r\nb\u2028c\u2029d\u0085e\u000Bf\u000Cg')).toBe(
			'a\nb\nc\nd\ne\nf\ng'
		);
		expect(splitWelcomeLines('a\u2028b')).toEqual(['a', 'b']);
	});
});

describe('styling a stretch of a line', () => {
	test('plain text takes a tag around the stretch', () => {
		expect(formatWelcomeLine('No cheating', 0, 11, { tag: 'Bold' })).toBe('<Bold>No cheating</>');
		expect(formatWelcomeLine('No cheating', 3, 11, { tag: 'Italic' })).toBe(
			'No <Italic>cheating</>'
		);
		expect(formatWelcomeLine('Rules', 0, 5, { tag: 'Header' })).toBe('<Header>Rules</>');
		expect(formatWelcomeLine('Rules', 0, 5, { tag: 'text', color: '#FF4D4D', size: 20 })).toBe(
			'<text color="#FF4D4D" size="20">Rules</>'
		);
	});
	test('tags do not nest: one the stretch cuts through is closed before it and opened after', () => {
		expect(formatWelcomeLine('<Bold>Hello world</>', 12, 17, { tag: 'Italic' })).toBe(
			'<Bold>Hello </><Italic>world</>'
		);
		expect(formatWelcomeLine('<Bold>one two three</>', 10, 13, { tag: 'Italic' })).toBe(
			'<Bold>one </><Italic>two</><Bold> three</>'
		);
		// a stretch that starts inside a tag's own markup starts at its text
		expect(formatWelcomeLine('<Bold>Hello world</>', 2, 20, { tag: 'Header' })).toBe(
			'<Header>Hello world</>'
		);
		for (const line of [
			formatWelcomeLine('<Bold>Hello world</>', 12, 17, { tag: 'Italic' }),
			formatWelcomeLine('<Bold>one two three</>', 10, 13, { tag: 'Italic' })
		])
			expect(checkWelcome([line], L)).toEqual([]);
	});
	test('the same style again changes nothing, and neighbours that look the same are one tag', () => {
		expect(formatWelcomeLine('<Bold>Hello world</>', 6, 11, { tag: 'Bold' })).toBe(
			'<Bold>Hello world</>'
		);
		expect(formatWelcomeLine('<Bold>a</>b', 0, 11, { tag: 'Bold' })).toBe('<Bold>ab</>');
		expect(formatWelcomeLine('a<Bold>b</>', 0, 1, { tag: 'Bold' })).toBe('<Bold>ab</>');
	});
	test('bold or italic on text with a colour keeps the colour; a colour on bold keeps it bold', () => {
		expect(formatWelcomeLine('<text color="#7FD6FF">English</>', 22, 29, { tag: 'Bold' })).toBe(
			'<text color="#7FD6FF" fontface="Bold">English</>'
		);
		expect(formatWelcomeLine('<Bold>English</>', 6, 13, { tag: 'text', color: '#7FD6FF' })).toBe(
			'<text color="#7FD6FF" fontface="Bold">English</>'
		);
		expect(
			formatWelcomeLine('<text color="#7FD6FF" size="12">ab</>', 32, 33, {
				tag: 'text',
				size: 18
			})
		).toBe('<text color="#7FD6FF" size="18">a</><text color="#7FD6FF" size="12">b</>');
	});
	test('a colour on a header becomes the notes’ own coloured title, since a header takes none', () => {
		const line = formatWelcomeLine('<Header>SERVER RULES</>', 8, 20, {
			tag: 'text',
			color: '#FF4D4D'
		});
		expect(line).toBe('<text color="#FF4D4D" size="20" fontface="Bold">SERVER RULES</>');
		expect(checkWelcome([line], L)).toEqual([]);
		// and a header over a look drops the look
		expect(formatWelcomeLine(line, 0, line.length, { tag: 'Header' })).toBe(
			'<Header>SERVER RULES</>'
		);
	});
	test('plain takes every style off the stretch', () => {
		expect(formatWelcomeLine('<Bold>x</> y <text color="#FFFFFF">z</>', 0, 99, null)).toBe('x y z');
		expect(formatWelcomeLine('<Bold>Hello world</>', 12, 17, null)).toBe('<Bold>Hello </>world');
	});
	test('a value kept from the tag as it was stays a value: its quote does not end the attribute', () => {
		const odd = '<text color="&quot;#FFF&quot; &amp; &lt;b&gt;">x</>';
		const bold = formatWelcomeLine(odd, 0, odd.length, { tag: 'Bold' });
		expect(bold).toBe('<text color="&quot;#FFF&quot; &amp; &lt;b&gt;" fontface="Bold">x</>');
		expect(parseWelcomeLine(bold)[0].attributes).toEqual([
			{ key: 'color', value: '"#FFF" & <b>' },
			{ key: 'fontface', value: 'Bold' }
		]);
	});
	test('an entity is taken whole, and a tag the popup does not keep is left as it is', () => {
		expect(formatWelcomeLine('a &lt; b', 3, 4, { tag: 'Bold' })).toBe('a <Bold>&lt;</> b');
		expect(formatWelcomeLine('<a href="x">y</> z', 0, 18, { tag: 'Bold' })).toBe(
			'<a href="x">y</><Bold> z</>'
		);
	});
	test('in a text box: the selection line by line, or the caret’s whole line', () => {
		// only a caret: its whole line, and the caret left at the end of the line's text
		expect(formatWelcome('one\ntwo\nthree', 5, 5, { tag: 'Bold' })).toEqual({
			value: 'one\n<Bold>two</>\nthree',
			selStart: 13,
			selEnd: 13
		});
		expect(formatWelcome('<Bold>two</>', 12, 12, null)).toEqual({
			value: 'two',
			selStart: 3,
			selEnd: 3
		});
		// a tag ends with its line, so three lines take three tags
		expect(formatWelcome('one\ntwo\nthree', 1, 9, { tag: 'Italic' })).toEqual({
			value: 'o<Italic>ne</>\n<Italic>two</>\n<Italic>t</>hree',
			selStart: 1,
			selEnd: 42
		});
		// a selection that ends where a line starts has nothing of that line
		expect(formatWelcome('one\ntwo', 0, 4, { tag: 'Bold' }).value).toBe('<Bold>one</>\ntwo');
		// nothing to style on an empty line
		expect(formatWelcome('one\n\ntwo', 4, 4, { tag: 'Bold' })).toEqual({
			value: 'one\n\ntwo',
			selStart: 4,
			selEnd: 4
		});
	});
	test('the selection stays on the stretch, so the next style lands on the same text', () => {
		const bold = formatWelcome('Hello world', 6, 11, { tag: 'Bold' });
		expect(bold).toEqual({ value: 'Hello <Bold>world</>', selStart: 6, selEnd: 20 });
		const italic = formatWelcome(bold.value, bold.selStart, bold.selEnd, { tag: 'Italic' });
		expect(italic).toEqual({ value: 'Hello <Italic>world</>', selStart: 6, selEnd: 22 });
		const plain = formatWelcome(italic.value, italic.selStart, italic.selEnd, null);
		expect(plain).toEqual({ value: 'Hello world', selStart: 6, selEnd: 11 });
		// the same style again leaves the tag whole, and the selection on the stretch inside it
		expect(formatWelcome('<Bold>Hello world</>', 12, 17, { tag: 'Bold' })).toEqual({
			value: '<Bold>Hello world</>',
			selStart: 12,
			selEnd: 17
		});
	});
});
