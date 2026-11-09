// ServerSettings.ini as a document: an Unreal-style ini with sections, scalar keys and array
// commands (+add-unique, .add, -remove, !clear). Parsing mirrors the official console; the
// setter edits the text in place so comments, ordering and array lines survive a form edit.

export interface IniEntry {
	key: string;
	values: string[];
	isArray: boolean;
}
export interface IniSection {
	name: string;
	keys: IniEntry[];
}
export interface ParsedIni {
	sections: IniSection[];
	warnings: string[];
}

const isComment = (line: string) => line.startsWith(';') || line.startsWith('#');
const isHeader = (line: string) => line.startsWith('[') && line.endsWith(']');

function splitCommand(rawKey: string): { cmd: string; key: string } {
	const first = rawKey.charAt(0);
	if (first === '+') return { cmd: 'addUnique', key: rawKey.slice(1).trim() };
	if (first === '.') return { cmd: 'add', key: rawKey.slice(1).trim() };
	if (first === '-') return { cmd: 'remove', key: rawKey.slice(1).trim() };
	if (first === '!') return { cmd: 'clear', key: rawKey.slice(1).trim() };
	return { cmd: 'set', key: rawKey.trim() };
}

export function parseIni(text: string): ParsedIni {
	const doc: ParsedIni = { sections: [], warnings: [] };
	if (!text) return doc;
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	let section: IniSection | null = null;
	body.split(/\r\n|\n|\r/).forEach((raw, index) => {
		const line = raw.trim();
		if (!line || isComment(line)) return;
		if (isHeader(line)) {
			const name = line.slice(1, -1).trim();
			if (!name) {
				doc.warnings.push(`line ${index + 1}: empty section header, skipped`);
				return;
			}
			section = findOrAddSection(doc, name);
			return;
		}
		const eq = line.indexOf('=');
		if (eq < 0) {
			doc.warnings.push(`line ${index + 1}: no '=' found, skipped`);
			return;
		}
		if (!section) {
			doc.warnings.push(`line ${index + 1}: key outside any section, skipped`);
			return;
		}
		const { cmd, key } = splitCommand(line.slice(0, eq));
		if (!key) {
			doc.warnings.push(`line ${index + 1}: unusable key name, skipped`);
			return;
		}
		const value = line.slice(eq + 1).trim();
		const entry = findOrAddKey(section, key);
		if (cmd === 'clear') {
			entry.isArray = true;
			entry.values = [];
		} else if (cmd === 'addUnique') {
			entry.isArray = true;
			if (!entry.values.includes(value)) entry.values.push(value);
		} else if (cmd === 'add') {
			entry.isArray = true;
			entry.values.push(value);
		} else if (cmd === 'remove') {
			entry.isArray = true;
			entry.values = entry.values.filter((v) => v !== value);
		} else {
			entry.isArray = false;
			entry.values = [value];
		}
	});
	return doc;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function findOrAddSection(doc: ParsedIni, name: string): IniSection {
	let s = doc.sections.find((x) => sameName(x.name, name));
	if (!s) {
		s = { name, keys: [] };
		doc.sections.push(s);
	}
	return s;
}
function findOrAddKey(section: IniSection, key: string): IniEntry {
	let e = section.keys.find((k) => sameName(k.key, key));
	if (!e) {
		e = { key, values: [], isArray: false };
		section.keys.push(e);
	}
	return e;
}

/** The scalar value of `key` in `section`, quotes stripped; null when absent. */
export function getScalar(doc: ParsedIni, section: string, key: string): string | null {
	const s = doc.sections.find((x) => sameName(x.name, section));
	const e = s?.keys.find((k) => sameName(k.key, key));
	return e && e.values.length ? unquote(e.values[0]) : null;
}

/** The array values of `key` in `section` (quotes stripped, in file order); [] when absent. */
export function getArray(doc: ParsedIni, section: string, key: string): string[] {
	const s = doc.sections.find((x) => sameName(x.name, section));
	const e = s?.keys.find((k) => sameName(k.key, key));
	return e ? e.values.map(unquote) : [];
}

/**
 * Replaces every array line for `key` in `section` with `!key=ClearArray` followed by one `.key=`
 * line per value, the way the server itself serialises arrays. The block goes where the first old
 * line was (or at the end of the section); everything else in the file is untouched.
 */
export function setArrayInText(
	text: string,
	section: string,
	key: string,
	values: string[]
): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text ? text.split(/\r\n|\n|\r/) : [];
	const block = [`!${key}=ClearArray`, ...values.map((v) => `.${key}=${quoteIfNeeded(v)}`)];

	let start = -1;
	let end = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!isHeader(line)) continue;
		if (start >= 0) {
			end = i;
			break;
		}
		if (sameName(line.slice(1, -1).trim(), section)) start = i;
	}
	if (start < 0) {
		const out = lines.slice();
		while (out.length && out[out.length - 1].trim() === '') out.pop();
		if (out.length) out.push('');
		out.push(`[${section}]`, ...block, '');
		return out.join(eol);
	}

	// Every line that sets this key: the array commands and a bare `Key=value` (which the parser
	// reads as one element), so no leftover line can restore a value that was removed.
	const isOurs = (raw: string) => {
		const line = raw.trim();
		if (!line || line.startsWith(';') || line.startsWith('#') || isHeader(line)) return false;
		const eq = line.indexOf('=');
		return (
			eq > 0 &&
			sameName(
				line
					.slice(0, eq)
					.trim()
					.replace(/^[+.!-]/, ''),
				key
			)
		);
	};
	let at = -1;
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > start && i < end && isOurs(lines[i])) {
			if (at < 0) at = kept.length;
			continue;
		}
		kept.push(lines[i]);
	}
	if (at < 0) {
		// Not present: before the section's trailing blank lines (the section shrank by nothing).
		at = end;
		while (at > start + 1 && kept[at - 1].trim() === '') at--;
	}
	kept.splice(at, 0, ...block);
	return kept.join(eol);
}

// ---- credentials --------------------------------------------------------------------------------

/**
 * The keys of the document that are credentials: the RCON password and its hash (whoever holds
 * either runs the server without the panel), the kill feed's token, and since CL-516586 the feed's
 * endpoints (`.EventFeedEndpoints=(Url="…",Token="…")`, hidden whole, as an address can carry a
 * secret too). Matched by name in any section. A struct value with one of them among its fields is
 * a credential whatever its key, so the next list of the kind the game adds is hidden before anyone
 * has looked at it. The join password (ServerPassword) is a setting people hand to players, not one
 * of these.
 */
export const SECRET_KEYS = ['Password', 'PasswordHash', 'Token', 'EventFeedEndpoints'] as const;
/** What stands in for a credential's value in any document the panel hands out. */
export const SECRET_PLACEHOLDER = '(hidden)';

/** The values of the credentials among a struct value's fields: `(Url="…",Token="…")` gives the token. */
function structSecrets(value: string): string[] {
	if (!value.startsWith('(')) return [];
	const field = new RegExp(
		`[(,]\\s*(?:${SECRET_KEYS.join('|')})\\s*=\\s*(?:"([^"]*)"|([^,)]*))`,
		'gi'
	);
	return [...value.matchAll(field)].map((m) => (m[1] ?? m[2] ?? '').trim());
}

interface SecretLine {
	index: number;
	/** section, key and whether the line is commented out: which line of the live document it answers to */
	slot: string;
	/** everything up to and including the '=' */
	head: string;
	value: string;
}

/**
 * Every line that sets a credential, commented out or not: an old password in a comment is still
 * one. A line already reading as the placeholder counts too, whatever its key: the panel put it
 * there, and a struct value it replaced no longer says what it held.
 */
function secretLines(lines: string[]): SecretLine[] {
	const out: SecretLine[] = [];
	let section = '';
	lines.forEach((raw, index) => {
		// A byte order mark sits in front of the first header; a client may or may not send it back.
		const line = (index === 0 ? raw.replace(/^﻿/, '') : raw).trim();
		if (isHeader(line)) {
			section = line.slice(1, -1).trim().toLowerCase();
			return;
		}
		const eq = raw.indexOf('=');
		if (eq < 0) return;
		const commented = isComment(line);
		const head = raw.slice(0, eq).replace(/^[\s;#]+/, '');
		const value = raw.slice(eq + 1).trim();
		// `!Key=ClearArray` empties a list and holds nothing; as a secret, that word would be hidden
		// wherever an answer quotes it (`!RotationEntries=ClearArray` included).
		if (head.startsWith('!') && /^cleararray$/i.test(value)) return;
		const key = head
			.replace(/^[+.!-]/, '')
			.trim()
			.toLowerCase();
		if (
			!SECRET_KEYS.some((k) => k.toLowerCase() === key) &&
			!structSecrets(value).length &&
			value !== SECRET_PLACEHOLDER
		)
			return;
		out.push({
			index,
			slot: `${section}\n${key}\n${commented}`,
			head: raw.slice(0, eq + 1),
			value
		});
	});
	return out;
}

const splitLines = (text: string) => ({
	eol: text.includes('\r\n') ? '\r\n' : '\n',
	lines: text.split(/\r\n|\n|\r/)
});

/** The document with every credential's value replaced by the placeholder; nothing else moves. */
export function redactSecrets(text: string): string {
	const { eol, lines } = splitLines(text);
	const found = secretLines(lines).filter((s) => s.value !== '');
	if (!found.length) return text;
	for (const s of found) lines[s.index] = s.head + SECRET_PLACEHOLDER;
	return lines.join(eol);
}

/**
 * What the game says about a document (warnings, changed lines, conflict deltas, error text) with
 * every credential value of `texts` replaced by the placeholder, wherever it is quoted. The
 * documented answers quote no values; this is for a build that does.
 */
export function hideSecretValues<T>(answer: T, ...texts: string[]): T {
	const values = new Set<string>();
	for (const text of texts)
		for (const s of secretLines(splitLines(text).lines)) {
			const bare = s.value.replace(/^"(.*)"$/, '$1');
			// A struct's token alone too: an answer may quote the field rather than the whole line.
			for (const v of [s.value, bare, ...structSecrets(s.value)])
				if (v && v !== SECRET_PLACEHOLDER) values.add(v);
		}
	if (!values.size) return answer;
	// Longest first, so a value that contains another is replaced whole.
	const ordered = [...values].sort((a, b) => b.length - a.length);
	const walk = (v: unknown): unknown => {
		if (typeof v === 'string')
			return ordered.reduce((out, secret) => out.split(secret).join(SECRET_PLACEHOLDER), v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === 'object')
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return walk(answer) as T;
}

/**
 * The other half of redactSecrets: `text` came back from someone who was shown placeholders, and
 * every credential line still holding one gets the value that line has in `live` (the document as
 * the game serves it now). A value they typed is theirs and stays. Throws when a placeholder has
 * no line in the live document to answer to, since it would otherwise be written as the password.
 */
export function restoreSecrets(text: string, live: string): string {
	const { eol, lines } = splitLines(text);
	const held = secretLines(lines).filter((s) => s.value === SECRET_PLACEHOLDER);
	if (!held.length) return text;
	const real = secretLines(splitLines(live).lines);
	const taken = new Map<string, number>();
	for (const s of held) {
		const nth = taken.get(s.slot) ?? 0;
		taken.set(s.slot, nth + 1);
		const source = real.filter((r) => r.slot === s.slot)[nth];
		if (!source)
			throw new Error(
				`${s.head.trim()}${SECRET_PLACEHOLDER} stands for a value the server does not have; type the value or remove the line.`
			);
		lines[s.index] = s.head + source.value;
	}
	return lines.join(eol);
}

export const unquote = (v: string): string =>
	v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;

function needsQuoting(value: string): boolean {
	if (!value) return false;
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return false;
	let inQuotes = false;
	for (let i = 0; i < value.length - 1; i++) {
		if (value[i] === '"') inQuotes = !inQuotes;
		else if (!inQuotes && value[i] === '/' && value[i + 1] === '/') return true;
	}
	return value.startsWith(' ') || value.endsWith(' ') || value.endsWith('\\');
}
export const quoteIfNeeded = (value: string): string =>
	needsQuoting(value) ? `"${value}"` : value;

/**
 * Sets `section.key=value` in the ini text with the smallest possible edit: the existing
 * scalar line is rewritten in place, a missing key is added at the end of its section, and a
 * missing section is appended. Everything else (comments, blank lines, array entries, the
 * file's line endings) is left exactly as it was.
 */
export function setScalarInText(text: string, section: string, key: string, value: string): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text ? text.split(/\r\n|\n|\r/) : [];
	const rendered = `${key}=${quoteIfNeeded(value)}`;

	let start = -1;
	let end = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!isHeader(line)) continue;
		if (start >= 0) {
			end = i;
			break;
		}
		if (sameName(line.slice(1, -1).trim(), section)) start = i;
	}
	if (start < 0) {
		const out = lines.slice();
		// Drop the trailing empty element a final EOL leaves behind, then keep one blank line
		// between the last section and the new one.
		while (out.length && out[out.length - 1].trim() === '') out.pop();
		if (out.length) out.push('');
		out.push(`[${section}]`, rendered, '');
		return out.join(eol);
	}

	for (let i = start + 1; i < end; i++) {
		const line = lines[i].trim();
		if (!line || isComment(line) || /^[+.!-]/.test(line)) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		if (sameName(line.slice(0, eq).trim(), key)) {
			const indent = lines[i].match(/^\s*/)?.[0] ?? '';
			lines[i] = indent + rendered;
			return lines.join(eol);
		}
	}
	// Not present: add after the section's last non-blank line, before its trailing blank lines.
	let at = end;
	while (at > start + 1 && lines[at - 1].trim() === '') at--;
	lines.splice(at, 0, rendered);
	return lines.join(eol);
}
