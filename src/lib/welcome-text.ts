// The text of the game's welcome popup (Season 3): the lines of ServerWelcomeMessageLines, one
// line of the popup each, in the markup of the game's rich text. What the popup takes, from the
// WARDOGS team's notes to server admins and the official console's own check of a line:
//
//   <Header>…</>   <Bold>…</>   <Italic>…</>                 a style, closed by </>
//   <text color="#RRGGBB" size="8-24" fontface="Bold">…</>   a look of one's own, any mix of the three
//   &lt; &gt; &amp; &quot;                                   the characters < > & " themselves
//
// A tag does not go inside another, a line is cut after the server's limit of visible characters
// (tags do not count, an entity counts as one), and anything else in angle brackets shows as
// typed. The game refuses a document with a line over a limit or with a tag it would not keep;
// `checkWelcome` says so before anything is sent, and adds what the game takes but shows as typed.

export interface WelcomeLimits {
	maxLines: number;
	/** visible characters in a line */
	maxLineLength: number;
	minFontSize: number;
	maxFontSize: number;
	maxCloseDelaySeconds: number;
}

/** The limits the WARDOGS team gave server admins. A server reports its own in its status. */
export const WELCOME_LIMITS: WelcomeLimits = {
	maxLines: 128,
	maxLineLength: 128,
	minFontSize: 8,
	maxFontSize: 24,
	maxCloseDelaySeconds: 60
};

/**
 * The limits a status reports under `welcomeMessage`, or null when it reports none (a build from
 * before Season 3) or anything but five whole numbers that make sense together: the game's own
 * words, bound for a number field's range and a font size, so only that shape is taken.
 */
export function welcomeLimitsOf(raw: unknown): WelcomeLimits | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const whole = (v: unknown, min: number, max: number): number | null =>
		typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
	const limits = {
		maxLines: whole(r.maxLines, 0, 10_000),
		maxLineLength: whole(r.maxLineLength, 0, 100_000),
		minFontSize: whole(r.minFontSize, 1, 1000),
		maxFontSize: whole(r.maxFontSize, 1, 1000),
		maxCloseDelaySeconds: whole(r.maxCloseDelaySeconds, 0, 86_400)
	};
	if (Object.values(limits).some((v) => v === null)) return null;
	if (limits.maxFontSize! < limits.minFontSize!) return null;
	return limits as WelcomeLimits;
}

// ---- reading a line --------------------------------------------------------------------------------

// Unreal's rich text markup: a name, attributes each after exactly one space with a value in
// straight quotes, then either `/>` or content up to the first `</>`. Names take letters, marks,
// digits, connectors, dots and hyphens.
const WORD = '\\p{L}\\p{M}\\p{N}\\p{Pc}';
const ELEMENT = new RegExp(`<([${WORD}.-]+)((?: [${WORD}.-]+="[^"]*")+)?(?:/>|>(.*?)</>)`, 'gu');
const ATTRIBUTE = new RegExp(`([${WORD}.]+)="([^"]*)"`, 'gu');

/** Everything the game's text takes for the end of a line. */
const LINE_BREAK = /\r\n|[\n\u000B\u000C\r\u0085\u2028\u2029]/;
const ENTITIES: Record<string, string> = { quot: '"', lt: '<', gt: '>', amp: '&' };
const ENTITY = /&(quot|lt|gt|amp);/g;
const unescapeText = (s: string): string => s.replace(ENTITY, (_, name: string) => ENTITIES[name]);
/** Text written so that the popup shows it as typed: `&`, `<` and `>` as their entities. */
export const escapeWelcome = (s: string): string =>
	s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

export interface WelcomeRun {
	/**
	 * plain: text outside any tag. style: a tag with no attributes (Header, Bold, Italic, or a name
	 * the popup has no style for). text: a `<text …>` tag. literal: a tag the popup does not keep
	 * (any other name with attributes), shown as typed.
	 */
	kind: 'plain' | 'style' | 'text' | 'literal';
	/** the tag's name as written; '' for plain text */
	name: string;
	/** what a player reads of it, entities resolved */
	text: string;
	/** the tag's attributes as written, the last of a repeated name */
	attributes: { key: string; value: string }[];
	/** where the run sits in the line as written */
	begin: number;
	end: number;
	/** the part of it that is text to restyle: all of a plain run, a kept tag's content, nothing of a literal */
	contentBegin: number;
	contentEnd: number;
}

/** A line of the popup as the game reads it: plain text and tags in turn. An empty line has no runs. */
export function parseWelcomeLine(line: string): WelcomeRun[] {
	const runs: WelcomeRun[] = [];
	const plain = (begin: number, end: number): WelcomeRun => ({
		kind: 'plain',
		name: '',
		text: unescapeText(line.slice(begin, end)),
		attributes: [],
		begin,
		end,
		contentBegin: begin,
		contentEnd: end
	});
	let last = 0;
	for (const m of line.matchAll(ELEMENT)) {
		const begin = m.index;
		const end = begin + m[0].length;
		if (begin > last) runs.push(plain(last, begin));
		last = end;

		const name = m[1];
		const attributes = new Map<string, string>();
		for (const a of (m[2] ?? '').matchAll(ATTRIBUTE)) attributes.set(a[1], unescapeText(a[2]));
		const isText = name.toLowerCase() === 'text';
		const kept = isText || attributes.size === 0;
		// `<Name/>` has no content: it shows nothing.
		const closed = m[3] !== undefined;
		const contentBegin = kept && closed ? begin + 1 + name.length + (m[2]?.length ?? 0) + 1 : end;
		const contentEnd = kept && closed ? end - 3 : end;
		runs.push({
			kind: !kept ? 'literal' : isText ? 'text' : 'style',
			name,
			text: unescapeText(kept ? line.slice(contentBegin, contentEnd) : line.slice(begin, end)),
			attributes: [...attributes].map(([key, value]) => ({ key, value })),
			begin,
			end,
			contentBegin,
			contentEnd
		});
	}
	if (line.length > last) runs.push(plain(last, line.length));
	return runs;
}

/** The characters of a line a player sees: tags do not count, an entity counts as one. */
export const visibleLength = (line: string): number =>
	parseWelcomeLine(line).reduce((n, run) => n + run.text.length, 0);

// ---- what the game refuses, and what it shows as typed ------------------------------------------

export interface WelcomeIssue {
	/** the line of the popup, from 1; null for the text as a whole */
	line: number | null;
	/** refused: the game does not take the document. typed: it does, and shows this as typed, or plain. */
	level: 'refused' | 'typed';
	message: string;
	/**
	 * What the editor offers to do about it: write what shows as typed as plain text
	 * (`plainWelcomeLine`), straighten a tag's quotes (`straightenQuotes`), or close tags the
	 * popup's way (`closeWelcomeTags`).
	 */
	fix?: 'plain' | 'quotes' | 'closers';
}

const STYLES = ['header', 'bold', 'italic'];
const FACES = ['bold', 'italic', 'regular'];
const TEXT_KEYS = ['color', 'size', 'fontface'];
const CURLY = /[\u201C\u201D\u201E\u201F\u2033]/;
/** #RRGGBB, or with two more digits for how solid it is, as the official console's preview takes it */
const COLOUR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
/** What someone meant as a tag: angle brackets around a name, or the closer on its own. */
const TAG_LIKE = /<\/?\p{L}[^<>]*>|<\/>/gu;
const NAMED_CLOSER = /^<\/[^<>/]+>$/;

/** A font size as the game takes it: a whole number in the server's range, written plainly. */
const sizeFits = (value: string, limits: WelcomeLimits): boolean => {
	const n = Number(value);
	return (
		/^\d+$/.test(value) && String(n) === value && n >= limits.minFontSize && n <= limits.maxFontSize
	);
};

/**
 * What a player reads as typed in a stretch of text the game took for plain (`raw`: a plain run, or
 * a kept tag's content), where someone meant a tag: the likeliest slip first, since one slip often
 * leaves several of these behind. A `<` that never looked like a tag (`<3`, `a < b`) shows as
 * typed too, as it was meant to, and is nobody's mistake.
 */
function typedHint(n: number, inTag: boolean, raw: string): WelcomeIssue | null {
	const tags = raw.match(TAG_LIKE);
	if (!tags) return null;
	const quote = (tag: string) => (tag.length > 28 ? `${tag.slice(0, 27)}…` : tag);
	const shows = (tag: string) => `Line ${n} shows ${quote(tag)} as typed`;
	const closer = tags.find((t) => NAMED_CLOSER.test(t));
	if (closer)
		return {
			line: n,
			level: 'typed',
			message: `${shows(closer)}: a tag is closed with </>, whatever its name.`,
			fix: 'closers'
		};
	const curly = tags.find((t) => CURLY.test(t));
	if (curly)
		return {
			line: n,
			level: 'typed',
			message: `${shows(curly)}: its quotes are curly, and a tag takes only straight ones.`,
			fix: 'quotes'
		};
	const [tag] = tags;
	if (inTag)
		return {
			line: n,
			level: 'typed',
			message: `${shows(tag)}: a tag cannot go inside another.`
		};
	if (tag === '</>')
		return { line: n, level: 'typed', message: `${shows(tag)}: no tag is open before it.` };
	return {
		line: n,
		level: 'typed',
		message: `${shows(tag)}: it is not closed with </>, or is not a tag the popup takes.`,
		fix: 'plain'
	};
}

/**
 * What is wrong with the popup's text. `refused` is what the game does not take, as its notes and
 * the official console's check have it: more lines than the limit, a line with more visible
 * characters than the limit, a tag with attributes that is not `<text>`, a `<text>` attribute
 * other than color, size and fontface, and a size that is not a whole number in range. Past the
 * line limit, lines are not looked at. `typed` is what the game takes and a player then reads as
 * typed or in the plain style: a tag left open, closed by name, nested or in curly quotes, a
 * style the popup does not have, a colour that is not #RRGGBB, a font face it does not know.
 */
export function checkWelcome(lines: string[], limits: WelcomeLimits): WelcomeIssue[] {
	const issues: WelcomeIssue[] = [];
	if (lines.length > limits.maxLines)
		issues.push({
			line: null,
			level: 'refused',
			message: `The popup takes ${limits.maxLines} lines, and this text has ${lines.length}.`
		});
	lines.slice(0, limits.maxLines).forEach((line, index) => {
		const n = index + 1;
		// From a file written by hand: the popup would break the line there, and no tag crosses it.
		if (LINE_BREAK.test(line))
			issues.push({
				line: n,
				level: 'refused',
				message: `Line ${n} has a line break inside it; each line of the popup is a line of its own.`
			});
		const runs = parseWelcomeLine(line);
		const visible = runs.reduce((sum, run) => sum + run.text.length, 0);
		if (visible > limits.maxLineLength)
			issues.push({
				line: n,
				level: 'refused',
				message: `Line ${n} has ${visible} visible characters, and the popup takes ${limits.maxLineLength}.`
			});

		let typed: WelcomeIssue | null = null;
		for (const run of runs) {
			if (run.kind === 'literal') {
				issues.push({
					line: n,
					level: 'refused',
					message:
						run.name.toLowerCase() === 'header'
							? `Line ${n}: <Header> takes no colour, size or font face. For a title with its own, use <text size="20" fontface="Bold" color="#RRGGBB">.`
							: `Line ${n}: <${run.name}> is not a tag the popup takes; only <text> has attributes.`,
					fix: 'plain'
				});
				continue;
			}
			if (run.kind === 'text') {
				for (const { key, value } of run.attributes) {
					const k = key.toLowerCase();
					if (!TEXT_KEYS.includes(k))
						issues.push({
							line: n,
							level: 'refused',
							message: `Line ${n}: <text> takes color, size and fontface, not ${key}.`
						});
					else if (k === 'size' && !sizeFits(value, limits))
						issues.push({
							line: n,
							level: 'refused',
							message: `Line ${n}: size="${value}" is not a whole number from ${limits.minFontSize} to ${limits.maxFontSize}.`
						});
					else if (k === 'color' && !COLOUR.test(value))
						issues.push({
							line: n,
							level: 'typed',
							message: `Line ${n}: color="${value}" is not a colour as #RRGGBB.`
						});
					else if (k === 'fontface' && !FACES.includes(value.toLowerCase()))
						issues.push({
							line: n,
							level: 'typed',
							message: `Line ${n}: fontface="${value}" is not Bold or Italic.`
						});
				}
			} else if (run.kind === 'style' && !STYLES.includes(run.name.toLowerCase())) {
				issues.push({
					line: n,
					level: 'typed',
					message: `Line ${n}: <${run.name}> is not one of the popup's styles (Header, Bold, Italic).`
				});
			}
			// One per line: the first stretch with something a player would read as typed.
			typed ??= typedHint(n, run.kind !== 'plain', line.slice(run.contentBegin, run.contentEnd));
		}
		if (typed) issues.push(typed);
	});
	return issues;
}

/** The issues that stop an apply: what the game refuses. */
export const refusedWelcome = (issues: WelcomeIssue[]): WelcomeIssue[] =>
	issues.filter((i) => i.level === 'refused');

/** Tags closed by name, as in HTML (`</Bold>`), closed the popup's way. */
export const closeWelcomeTags = (line: string): string =>
	line.replace(TAG_LIKE, (tag) => (NAMED_CLOSER.test(tag) ? '</>' : tag));

/**
 * The line with everything a player would read as typed written as plain text: a tag the popup
 * does not keep, and any `<` or `>` left in the text or inside a tag, become their entities. It
 * reads the same in the game, and the game takes it.
 */
export function plainWelcomeLine(line: string): string {
	const escapeBrackets = (s: string) => s.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
	return parseWelcomeLine(line)
		.map((run) =>
			run.kind === 'literal'
				? escapeBrackets(line.slice(run.begin, run.end))
				: line.slice(run.begin, run.contentBegin) +
					escapeBrackets(line.slice(run.contentBegin, run.contentEnd)) +
					line.slice(run.contentEnd, run.end)
		)
		.join('');
}

/** Curly double quotes inside angle brackets made straight: a tag pasted from a chat message. */
export const straightenQuotes = (line: string): string =>
	line.replace(/<[^<>]*>/g, (tag) => tag.replace(new RegExp(CURLY.source, 'g'), '"'));

// ---- the popup as a player sees it ---------------------------------------------------------------

export interface PreviewRun {
	text: string;
	header: boolean;
	bold: boolean;
	italic: boolean;
	/** #RRGGBB or #RRGGBBAA, safe for a style attribute; '' for the popup's own colour */
	color: string;
	/** a font size within the server's range; null for the style's own */
	size: number | null;
}

/** As the game reads a size: the whole number a value starts with (0 without one), held to the range. */
function clampedSize(value: string, limits: WelcomeLimits): number {
	const m = /^\s*([+-]?\d+)/.exec(value);
	return Math.min(limits.maxFontSize, Math.max(limits.minFontSize, m ? Number(m[1]) : 0));
}

/**
 * A line as the popup draws it: each run with its style, sizes held to the server's range, and
 * the line cut after the limit of visible characters (`cut` says it was).
 */
export function previewWelcomeLine(
	line: string,
	limits: WelcomeLimits
): { runs: PreviewRun[]; cut: boolean } {
	const out: PreviewRun[] = [];
	let room = Math.max(0, limits.maxLineLength);
	let cut = false;
	for (const run of parseWelcomeLine(line)) {
		const text = run.text.slice(0, room);
		room -= text.length;
		cut ||= text.length < run.text.length;
		if (!text) continue;
		const name = run.name.toLowerCase();
		const shown: PreviewRun = {
			text,
			header: run.kind === 'style' && name === 'header',
			bold: run.kind === 'style' && (name === 'header' || name === 'bold'),
			italic: run.kind === 'style' && name === 'italic',
			color: '',
			size: null
		};
		if (run.kind === 'text')
			for (const { key, value } of run.attributes) {
				const k = key.toLowerCase();
				if (k === 'size') shown.size = clampedSize(value, limits);
				else if (k === 'color' && COLOUR.test(value)) shown.color = value;
				else if (k === 'fontface' && FACES.includes(value.toLowerCase())) {
					shown.bold = value.toLowerCase() === 'bold';
					shown.italic = value.toLowerCase() === 'italic';
				}
			}
		out.push(shown);
	}
	return { runs: out, cut };
}

// ---- writing it ----------------------------------------------------------------------------------

/** A text box's content with every kind of line break made the one a text box keeps. */
export const normaliseBreaks = (text: string): string =>
	text.replace(new RegExp(LINE_BREAK.source, 'g'), '\n');

/**
 * The popup's lines from a text box: one per line, an empty one a blank spacer, and none for the
 * empty lines at the end, which are a caret waiting on a new line and not a gap anyone asked for.
 */
export function splitWelcomeLines(text: string): string[] {
	const lines = text.split(LINE_BREAK);
	while (lines.length && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/** A style for a stretch of text: one of the popup's three, a look of one's own, or none (plain). */
export type WelcomeFormat =
	| { tag: 'Header' | 'Bold' | 'Italic' }
	| { tag: 'text'; color?: string; size?: number; fontface?: 'Bold' | 'Italic' }
	| null;

interface Look {
	color?: string;
	size?: string;
	fontface?: string;
}

/** A run's own look as `<text>` attributes: a text tag's as written, a style's nearest equivalent. */
function lookOf(run: WelcomeRun): Look {
	const name = run.name.toLowerCase();
	if (run.kind === 'style')
		return name === 'header'
			? { size: '20', fontface: 'Bold' }
			: name === 'bold'
				? { fontface: 'Bold' }
				: name === 'italic'
					? { fontface: 'Italic' }
					: {};
	const look: Look = {};
	if (run.kind === 'text')
		for (const { key, value } of run.attributes) {
			const k = key.toLowerCase();
			if (k === 'color' || k === 'size' || k === 'fontface') look[k] = value;
		}
	return look;
}

/** The opening tag `format` gives text that so far looked like `run`; '' for plain text. */
function openerFor(run: WelcomeRun, format: WelcomeFormat): string {
	if (!format) return '';
	let look: Look;
	if (format.tag === 'text') {
		// A look of one's own over what the text had: a colour on a bold stretch keeps it bold, and
		// on a header becomes the notes' own answer to "a coloured title", size 20 in bold.
		look = { ...lookOf(run) };
		if (format.color !== undefined) look.color = format.color;
		if (format.size !== undefined) look.size = String(format.size);
		if (format.fontface !== undefined) look.fontface = format.fontface;
	} else if (format.tag !== 'Header' && run.kind === 'text') {
		// Bold or italic on text with a colour or size of its own keeps those: tags do not nest.
		look = { ...lookOf(run), fontface: format.tag };
	} else return `<${format.tag}>`;
	const set = (['color', 'size', 'fontface'] as const).filter((k) => look[k]);
	// A face and nothing else is the style of that name.
	const face = (look.fontface ?? '').toLowerCase();
	if (set.length === 1 && set[0] === 'fontface' && (face === 'bold' || face === 'italic'))
		return face === 'bold' ? '<Bold>' : '<Italic>';
	// A value kept from the tag as it was goes back as an attribute can hold it: no quote of its own.
	const written = (k: keyof Look) => escapeWelcome(look[k]!).replace(/"/g, '&quot;');
	return set.length ? `<text${set.map((k) => ` ${k}="${written(k)}"`).join('')}>` : '';
}

/**
 * `line` with the text between `begin` and `end` (offsets into the line as written) given
 * `format`, and where the restyled text now sits: `from` and `to` around it, tags included, and
 * `inside` at the end of its text, before any closing tag (all -1 when nothing was restyled).
 * Tags do not nest, so a tag the stretch cuts through is closed before it and opened again after
 * it; a stretch that ends inside an entity takes the whole entity; a tag the popup does not keep
 * is left as it is.
 */
function restyle(
	line: string,
	begin: number,
	end: number,
	format: WelcomeFormat
): { line: string; from: number; to: number; inside: number } {
	for (const m of line.matchAll(ENTITY)) {
		const stop = m.index + m[0].length;
		if (begin > m.index && begin < stop) begin = m.index;
		if (end > m.index && end < stop) end = stop;
	}
	interface Piece {
		open: string;
		content: string;
		close: string;
		touched: boolean;
		/** the restyled part of the content, when some of it was */
		mark: [number, number] | null;
	}
	const pieces: Piece[] = [];
	const add = (open: string, content: string, touched: boolean) => {
		if (!content && !touched) return;
		const close = open ? '</>' : '';
		const last = pieces[pieces.length - 1];
		// Neighbours that now look the same become one tag.
		if (last && last.open === open && last.close === close && (last.touched || touched)) {
			const at = last.content.length;
			last.content += content;
			if (touched) last.mark = [last.mark?.[0] ?? at, at + content.length];
			last.touched = true;
		} else
			pieces.push({ open, content, close, touched, mark: touched ? [0, content.length] : null });
	};
	for (const run of parseWelcomeLine(line)) {
		const own = line.slice(run.begin, run.contentBegin);
		const content = line.slice(run.contentBegin, run.contentEnd);
		// Nothing to restyle: a tag the popup does not keep, or one with no text in it.
		if (run.kind === 'literal' || !content) {
			pieces.push({
				open: '',
				content: line.slice(run.begin, run.end),
				close: '',
				touched: false,
				mark: null
			});
			continue;
		}
		const from = Math.max(begin, run.contentBegin);
		const to = Math.min(end, run.contentEnd);
		if (from >= to) {
			add(own, content, false);
			continue;
		}
		add(own, line.slice(run.contentBegin, from), false);
		add(openerFor(run, format), line.slice(from, to), true);
		add(own, line.slice(to, run.contentEnd), false);
	}
	let out = '';
	let from = -1;
	let to = -1;
	let inside = -1;
	for (const p of pieces) {
		if (p.mark) {
			// With its tags where the restyled text is all the tag holds, without them where it is not.
			const text = out.length + p.open.length;
			const all = p.mark[0] === 0 && p.mark[1] === p.content.length;
			if (from < 0) from = all ? out.length : text + p.mark[0];
			inside = text + p.mark[1];
			to = all ? inside + p.close.length : inside;
		}
		out += p.open + p.content + p.close;
	}
	return { line: out, from, to, inside };
}

export const formatWelcomeLine = (
	line: string,
	begin: number,
	end: number,
	format: WelcomeFormat
): string => restyle(line, begin, end, format).line;

/**
 * A text box's content with `format` given to its selection, line by line (a tag ends with its
 * line). With nothing selected the whole line the caret is on is styled. Answers the new content
 * and where the selection goes: over the restyled text, so the next style lands on the same
 * stretch, or, where there was only a caret, a caret at the end of the line's text, so typing
 * carries on in the style just given.
 */
export function formatWelcome(
	value: string,
	selStart: number,
	selEnd: number,
	format: WelcomeFormat
): { value: string; selStart: number; selEnd: number } {
	const whole = selStart === selEnd;
	let offset = 0;
	let written = 0;
	let from = -1;
	let to = -1;
	let inside = -1;
	const out = value.split('\n').map((line, index) => {
		const start = offset;
		const stop = start + line.length;
		offset = stop + 1;
		const at = written + index;
		// A selection that ends at the very start of a line has nothing of that line in it.
		const touched = whole
			? selStart >= start && selStart <= stop
			: selStart < stop && selEnd > start;
		const next = !touched
			? null
			: whole
				? restyle(line, 0, line.length, format)
				: restyle(line, Math.max(selStart, start) - start, Math.min(selEnd, stop) - start, format);
		written += (next?.line ?? line).length;
		if (!next || next.from < 0) return next?.line ?? line;
		if (from < 0) from = at + next.from;
		to = at + next.to;
		inside = at + next.inside;
		return next.line;
	});
	if (from < 0) return { value, selStart, selEnd };
	return whole
		? { value: out.join('\n'), selStart: inside, selEnd: inside }
		: { value: out.join('\n'), selStart: from, selEnd: to };
}
