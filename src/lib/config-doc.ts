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

	const isOurs = (raw: string) => {
		const line = raw.trim();
		if (!/^[+.!-]/.test(line)) return false;
		const eq = line.indexOf('=');
		return eq > 0 && sameName(line.slice(1, eq).trim(), key);
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
