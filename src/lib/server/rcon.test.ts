import { test, expect } from 'bun:test';
import { classifyGameError } from './rcon';

// Shapes captured from live build ++Wardogs+Live-CL-499480 on 2026-09-11.
test('a route the build does not serve becomes no_route with the route in the message', () => {
	const e = classifyGameError('POST', '/v1/reserved-slots', 404, 'Not Found', {
		error: { code: 'not_found', message: 'No such endpoint.' }
	});
	expect(e.code).toBe('no_route');
	expect(e.status).toBe(404);
	expect(e.message).toBe('This server build does not serve POST /v1/reserved-slots.');
});

test('a missing ban keeps its own code', () => {
	const e = classifyGameError('DELETE', '/v1/bans/1', 404, 'Not Found', {
		error: { code: 'ban_not_found', message: 'Error: SteamId 1 is not currently banned.' }
	});
	expect(e.code).toBe('ban_not_found');
	expect(e.message).toContain('not currently banned');
});

test('a wrong method names the route', () => {
	const e = classifyGameError('PUT', '/v1/sponsor', 405, '', {
		error: { code: 'method_not_allowed', message: 'PUT is not supported on this endpoint.' }
	});
	expect(e.code).toBe('method_not_allowed');
	expect(e.message).toContain('PUT /v1/sponsor');
});

test('other failures pass the server message through', () => {
	const e = classifyGameError('GET', '/v1/status', 401, 'Unauthorized', {
		error: { code: 'unauthorized', message: 'Bad token.' }
	});
	expect(e.message).toBe('Bad token.');
	expect(classifyGameError('GET', '/v1/x', 500, 'Boom', null).message).toBe(
		'Server answered 500 Boom.'
	);
});
