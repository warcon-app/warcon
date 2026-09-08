import { describe, expect, test } from 'bun:test';
import { ApiError, publicMessage } from './http';

describe('publicMessage', () => {
	test('passes our own errors through', () => {
		expect(publicMessage(new ApiError(400, 'name is required.'))).toBe('name is required.');
	});

	test('hides everything else behind a generic line', () => {
		const quiet = console.error;
		console.error = () => {};
		try {
			expect(publicMessage(new Error('password authentication failed for user "warcon"'))).toBe(
				'Internal error.'
			);
			expect(publicMessage('boom', 'Poll failed.')).toBe('Poll failed.');
		} finally {
			console.error = quiet;
		}
	});
});
