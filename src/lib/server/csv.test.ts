import { describe, expect, test } from 'bun:test';
import { csvCell } from './csv';

describe('csvCell', () => {
	test('plain values pass through, delimiters and quotes are quoted', () => {
		expect(csvCell('hello')).toBe('hello');
		expect(csvCell(42)).toBe('42');
		expect(csvCell(null)).toBe('');
		expect(csvCell(undefined)).toBe('');
		expect(csvCell('a,b')).toBe('"a,b"');
		expect(csvCell('say "hi"')).toBe('"say ""hi"""');
		expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
		expect(csvCell(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
		expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
	});

	test('formula-looking text is neutralised', () => {
		expect(csvCell('=1+1')).toBe(`"'=1+1"`);
		expect(csvCell('+SUM(A1)')).toBe(`"'+SUM(A1)"`);
		expect(csvCell('-2+3')).toBe(`"'-2+3"`);
		expect(csvCell('@cmd')).toBe(`"'@cmd"`);
		expect(csvCell('\tx')).toBe(`"'\tx"`);
		expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
	});

	test('numbers are never touched, so negative durations stay numeric', () => {
		expect(csvCell(-5)).toBe('-5');
	});
});
