/**
 * One CSV cell. Quotes and escapes as usual, and text that a spreadsheet would run as a formula
 * (a cell starting with = + - @, a tab or a carriage return) is prefixed with an apostrophe and
 * quoted, per OWASP's CSV injection guidance. Only strings can come from users; numbers, dates
 * and JSON objects are emitted as they are.
 */
export function csvCell(v: unknown): string {
	let s =
		v === null || v === undefined
			? ''
			: v instanceof Date
				? v.toISOString()
				: typeof v === 'object'
					? JSON.stringify(v)
					: String(v);
	const formula = typeof v === 'string' && /^[=+\-@\t\r]/.test(s);
	if (formula) s = `'${s}`;
	return formula || /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
