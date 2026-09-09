import { describe, expect, test } from 'bun:test';
import { toDatetimeLocal } from './format';

describe('toDatetimeLocal', () => {
	test('round-trips through a datetime-local field in the local timezone', () => {
		const iso = '2026-09-09T09:00:00.000Z';
		const field = toDatetimeLocal(iso);
		expect(field).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		// The browser reads the field as local time; converting back must give the same instant.
		expect(new Date(field).toISOString()).toBe(iso);
	});

	test('blank for missing or invalid input', () => {
		expect(toDatetimeLocal('')).toBe('');
		expect(toDatetimeLocal(undefined)).toBe('');
		expect(toDatetimeLocal('not a date')).toBe('');
	});
});
