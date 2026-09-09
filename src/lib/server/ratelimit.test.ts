import { beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from './http';
import { assertRate, resetRates } from './ratelimit';

describe('assertRate', () => {
	beforeEach(resetRates);

	test('allows up to the limit, then answers 429 with a retry hint', () => {
		for (let i = 0; i < 3; i++) assertRate('test:u1', 3, 60_000);
		let caught: unknown;
		try {
			assertRate('test:u1', 3, 60_000);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ApiError);
		expect((caught as ApiError).status).toBe(429);
		expect((caught as ApiError).code).toBe('rate_limited');
		expect((caught as ApiError).message).toMatch(/try again in \d+ seconds?/);
	});

	test('keys are independent', () => {
		for (let i = 0; i < 3; i++) assertRate('test:u1', 3, 60_000);
		expect(() => assertRate('test:u2', 3, 60_000)).not.toThrow();
		expect(() => assertRate('raw:u1', 3, 60_000)).not.toThrow();
	});

	test('old stamps fall out of the window', () => {
		for (let i = 0; i < 3; i++) assertRate('k', 3, 1);
		const until = Date.now() + 3;
		while (Date.now() < until) {
			/* let the window pass */
		}
		expect(() => assertRate('k', 3, 1)).not.toThrow();
	});
});
