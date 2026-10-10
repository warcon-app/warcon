import { test, expect, mock, spyOn } from 'bun:test';

// actions.ts reaches env.ts, which imports SvelteKit's env alias; outside the app that alias does
// not resolve, so it is stubbed before the registry is loaded.
mock.module('$env/dynamic/private', () => ({ env: process.env }));
const { ACTIONS } = await import('./actions');
const { GameError } = await import('./rcon');

// The official console moves the faction and then kills the player so they respawn on the new
// side; a kill that fails (no living character) is not an error.
function fakeClient(killFails: boolean) {
	const calls: string[] = [];
	const client: any = {
		json: async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			if (path.endsWith('/kill') && killFails)
				throw new GameError(404, 'No living character.', 'not_alive');
			return { message: 'Moved X to Valkyra.' };
		}
	};
	return { client, calls };
}

test('changeTeam moves the faction then kills the player', async () => {
	const { client, calls } = fakeClient(false);
	const r: any = await ACTIONS.changeTeam.run(client, {
		steamId: '76561198000000001',
		faction: 'Valkyra'
	});
	expect(calls).toEqual([
		'PATCH /v1/players/76561198000000001',
		'POST /v1/players/76561198000000001/kill'
	]);
	expect(r.respawned).toBe(true);
	expect(r.message).toContain('respawn');
});

test('kill sends an empty JSON body', async () => {
	const calls: { method: string; path: string; body: unknown }[] = [];
	const client: any = {
		json: async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			return { message: 'OK: killed Player.' };
		}
	};
	await ACTIONS.kill.run(client, { steamId: '76561198000000001' });
	expect(calls).toEqual([
		{
			method: 'POST',
			path: '/v1/players/76561198000000001/kill',
			body: {}
		}
	]);
});

test('changeTeam sends an empty JSON body with its respawn kill', async () => {
	const calls: { method: string; path: string; body: unknown }[] = [];
	const client: any = {
		json: async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			return { message: 'OK.' };
		}
	};
	await ACTIONS.changeTeam.run(client, {
		steamId: '76561198000000001',
		faction: 'Valkyra'
	});
	expect(calls).toEqual([
		{
			method: 'PATCH',
			path: '/v1/players/76561198000000001',
			body: { faction: 'Valkyra' }
		},
		{
			method: 'POST',
			path: '/v1/players/76561198000000001/kill',
			body: {}
		}
	]);
});

test('changeTeam with kill: false sends the move alone', async () => {
	const { client, calls } = fakeClient(false);
	const r: any = await ACTIONS.changeTeam.run(client, {
		steamId: '76561198000000001',
		faction: 'Valkyra',
		kill: false
	});
	expect(calls).toEqual(['PATCH /v1/players/76561198000000001']);
	expect(r.message).toBe('Moved to Valkyra.');
});

test('changeTeam tolerates a failed kill', async () => {
	const { client, calls } = fakeClient(true);
	const r: any = await ACTIONS.changeTeam.run(client, {
		steamId: '76561198000000001',
		faction: 'Valkyra'
	});
	expect(calls.length).toBe(2);
	expect(r.respawned).toBe(false);
	expect(r.message).toContain('No living character');
});

test('changeTeam requires a faction', async () => {
	const { client, calls } = fakeClient(false);
	await expect(
		ACTIONS.changeTeam.run(client, { steamId: '76561198000000001', faction: '' })
	).rejects.toThrow('faction is required');
	expect(calls.length).toBe(0);
});

// The route list live build ++Wardogs+Live-CL-499480 advertised on 2026-09-11: no reserved-slot or
// rotation write routes, no PATCH /v1/settings, no PUT /v1/sponsor, but a config document.
const LIVE_ROUTES = [
	'DELETE /v1/bans/{steamId}',
	'GET /v1/audit',
	'GET /v1/bans',
	'GET /v1/capabilities',
	'GET /v1/catalog/experiences',
	'GET /v1/catalog/lightings',
	'GET /v1/catalog/maps',
	'GET /v1/catalog/maps/{map}/alternators',
	'GET /v1/catalog/maps/{map}/experiences',
	'GET /v1/config',
	'GET /v1/health',
	'GET /v1/players',
	'GET /v1/reserved-slots',
	'GET /v1/rotation',
	'GET /v1/sponsor',
	'GET /v1/status',
	'PATCH /v1/players/{id}',
	'POST /v1/bans',
	'POST /v1/broadcast',
	'POST /v1/config/validate',
	'POST /v1/match/end',
	'POST /v1/match/map',
	'POST /v1/match/restart',
	'POST /v1/players/{id}/kick',
	'POST /v1/players/{id}/kill',
	'POST /v1/players/{id}/message',
	'PUT /v1/config',
	'PUT /v1/world/lighting'
];

test('capabilities reads the live build CL-499480 route list into feature flags', async () => {
	const client: any = {
		json: async () => ({ routes: LIVE_ROUTES, config: { writable: true, document: '/v1/config' } })
	};
	const r: any = await ACTIONS.capabilities.run(client, {});
	expect(r.features).toEqual({
		changeTeam: true,
		configDocument: true,
		reservedSlots: false,
		rotationEdit: false,
		rotationSave: false,
		liveSettings: false,
		serverId: false
	});
});

// Live build CL-501228 (2026-09-14) added exactly one route to that list.
test('capabilities reads live build CL-501228: the same flags plus the server id', async () => {
	const client: any = {
		json: async () => ({
			apiVersion: '1',
			build: '++Wardogs+Live-CL-501228',
			routes: [...LIVE_ROUTES, 'GET /v1/server-id'],
			config: { writable: true, document: '/v1/config' }
		})
	};
	const r: any = await ACTIONS.capabilities.run(client, {});
	expect(r.features.serverId).toBe(true);
	expect(r.features.reservedSlots).toBe(false);
	expect(r.raw.build).toBe('++Wardogs+Live-CL-501228');
});

test('serverId reads GET /v1/server-id and always answers a string', async () => {
	const calls: string[] = [];
	const client: any = {
		json: async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			return { serverId: 'fd6926f9-57b6-48ce-9608-ad5f7de8c92a' };
		}
	};
	expect(await ACTIONS.serverId.run(client, {})).toEqual({
		serverId: 'fd6926f9-57b6-48ce-9608-ad5f7de8c92a'
	});
	expect(calls).toEqual(['GET /v1/server-id']);
	client.json = async () => ({});
	expect(await ACTIONS.serverId.run(client, {})).toEqual({ serverId: '' });
});

test('capabilities keeps every flag on for a build that serves the full console route set', async () => {
	const full = [
		...LIVE_ROUTES,
		'POST /v1/reserved-slots',
		'DELETE /v1/reserved-slots/{steamId}',
		'POST /v1/rotation/entries',
		'DELETE /v1/rotation/entries/{index}',
		'POST /v1/rotation/entries/{index}/move',
		'POST /v1/rotation/save',
		'PATCH /v1/settings',
		'GET /v1/server-id'
	];
	const client: any = { json: async () => ({ routes: full, config: { writable: true } }) };
	const r: any = await ACTIONS.capabilities.run(client, {});
	expect(Object.values(r.features).every(Boolean)).toBe(true);
});

// Reserved slots: the live route when the build serves it, the DefaultReservedPlayerIds array of
// the config document when it does not (live builds CL-499480 and CL-501228). The fake records
// every call as "METHOD path" (json) or "METHOD path revision" (configCall).
const SESSION = '[/Script/WDGame.WDGameSession]';
function reservedClient(opts: {
	route: boolean;
	text: string;
	writable?: boolean;
	conflicts?: number;
	routeError?: InstanceType<typeof GameError>;
	/** what GET /v1/reserved-slots answers (the live builds serve the read without the writes) */
	live?: string[];
}) {
	const calls: string[] = [];
	let text = opts.text;
	let rev = 1;
	let conflicts = opts.conflicts ?? 0;
	const client: any = {
		json: async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			if (path.startsWith('/v1/reserved-slots')) {
				if (method === 'GET' && opts.live) return { reservedSlots: opts.live };
				if (opts.routeError) throw opts.routeError;
				if (!opts.route)
					throw new GameError(404, 'This server build does not serve it.', 'no_route');
				return { message: 'Reserved slot added.' };
			}
			throw new Error(`unexpected ${method} ${path}`);
		},
		// The config action reads raw for the ETag; the body carries the revision as CL-501228 does.
		raw: async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			if (path !== '/v1/config') throw new Error(`unexpected ${method} ${path}`);
			return {
				status: 200,
				statusText: 'OK',
				headers: { etag: `"r${rev}"` },
				text: JSON.stringify({
					revision: `r${rev}`,
					writable: opts.writable ?? true,
					text,
					sections: []
				})
			};
		},
		configCall: async (method: string, path: string, body: string, revision: string) => {
			calls.push(`${method} ${path} ${revision}`);
			rev++;
			if (conflicts > 0) {
				conflicts--;
				return {
					status: 412,
					body: { ok: false, error: { code: 'revision_mismatch', message: 'changed' } }
				};
			}
			text = body;
			return { status: 200, body: { ok: true, revision: `r${rev}` } };
		}
	};
	return { client, calls, text: () => text };
}
const ID = '76561198000000123';

test('reservedAdd uses the live route when the build serves it', async () => {
	const f = reservedClient({ route: true, text: `${SESSION}\n` });
	const r: any = await ACTIONS.reservedAdd.run(f.client, { steamId: ID });
	expect(f.calls).toEqual(['POST /v1/reserved-slots']);
	expect(r.via).toBeUndefined();
});

test('reservedAdd falls back to the document on no_route and writes only that key', async () => {
	const f = reservedClient({
		route: false,
		text: `${SESSION}\r\nServerName=x\r\nMaxReservedSlots=5\r\n!DefaultReservedPlayerIds=ClearArray\r\n.DefaultReservedPlayerIds=76561198000000001\r\n`
	});
	const r: any = await ACTIONS.reservedAdd.run(f.client, { steamId: ID });
	expect(f.calls).toEqual([
		'POST /v1/reserved-slots',
		'GET /v1/config',
		'PUT /v1/config r1',
		'GET /v1/reserved-slots'
	]);
	expect(r.via).toBe('config');
	expect(r.revision).toBe('r2');
	// no read route either: nothing to compare the document against
	expect(r.pendingRestart).toBe(false);
	expect(r.message).toContain(ID);
	expect(f.text()).toBe(
		`${SESSION}\r\nServerName=x\r\nMaxReservedSlots=5\r\n!DefaultReservedPlayerIds=ClearArray\r\n.DefaultReservedPlayerIds=76561198000000001\r\n.DefaultReservedPlayerIds=${ID}\r\n`
	);
});

test('viaConfig skips the live route; reservedRemove drops the id', async () => {
	const f = reservedClient({
		route: true,
		text: `${SESSION}\n!DefaultReservedPlayerIds=ClearArray\n.DefaultReservedPlayerIds=${ID}\n`
	});
	const r: any = await ACTIONS.reservedRemove.run(f.client, { steamId: ID, viaConfig: true });
	expect(f.calls).toEqual(['GET /v1/config', 'PUT /v1/config r1', 'GET /v1/reserved-slots']);
	expect(r.via).toBe('config');
	expect(f.text()).toBe(`${SESSION}\n!DefaultReservedPlayerIds=ClearArray\n`);
});

// Seen on a real CL-501228 server 2026-09-15: the document edit lands, but the running server
// keeps the list it loaded at start, so GET /v1/reserved-slots still lists a withdrawn id.
test('a document edit the running server has not taken up is reported as pending a restart', async () => {
	let f = reservedClient({
		route: false,
		live: [ID],
		text: `${SESSION}\n!DefaultReservedPlayerIds=ClearArray\n.DefaultReservedPlayerIds=${ID}\n`
	});
	let r: any = await ACTIONS.reservedRemove.run(f.client, { steamId: ID, viaConfig: true });
	expect(f.text()).toBe(`${SESSION}\n!DefaultReservedPlayerIds=ClearArray\n`);
	expect(r.pendingRestart).toBe(true);
	expect(r.message).toMatch(/keeps it until it restarts/);

	f = reservedClient({ route: false, live: [], text: `${SESSION}\n` });
	r = await ACTIONS.reservedAdd.run(f.client, { steamId: ID, viaConfig: true });
	expect(r.pendingRestart).toBe(true);
	expect(r.message).toMatch(/when it restarts/);

	// the running list agrees with the document: nothing pending
	f = reservedClient({
		route: false,
		live: [],
		text: `${SESSION}\n.DefaultReservedPlayerIds=${ID}\n`
	});
	r = await ACTIONS.reservedRemove.run(f.client, { steamId: ID, viaConfig: true });
	expect(r.pendingRestart).toBe(false);
	expect(r.message).toBe(`Removed the reserved slot for ${ID}.`);
});

test('the reserved read returns the document list beside the live one when asked', async () => {
	const f = reservedClient({
		route: false,
		live: [ID],
		text: `${SESSION}\n.DefaultReservedPlayerIds=76561198000000002\n`
	});
	expect(await ACTIONS.reserved.run(f.client, {})).toEqual({ reserved: [ID] });
	expect(await ACTIONS.reserved.run(f.client, { document: '1' })).toEqual({
		reserved: [ID],
		document: ['76561198000000002']
	});
});

test('the document path reports present and absent with the codes the sync expects', async () => {
	const two = `${SESSION}\nMaxReservedSlots=2\n.DefaultReservedPlayerIds=${ID}\n.DefaultReservedPlayerIds=76561198000000002\n`;
	let f = reservedClient({ route: false, text: two });
	await expect(ACTIONS.reservedAdd.run(f.client, { steamId: ID })).rejects.toMatchObject({
		status: 409,
		code: 'already_reserved'
	});
	expect(f.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);

	f = reservedClient({ route: false, text: `${SESSION}\n` });
	await expect(
		ACTIONS.reservedRemove.run(f.client, { steamId: ID, viaConfig: true })
	).rejects.toMatchObject({ status: 404, code: 'reserved_not_found' });
});

test('MaxReservedSlots never limits the list: a third id goes in beside two held slots', async () => {
	const two = `${SESSION}\nMaxReservedSlots=2\n.DefaultReservedPlayerIds=${ID}\n.DefaultReservedPlayerIds=76561198000000002\n`;
	const f = reservedClient({ route: false, text: two });
	const r: any = await ACTIONS.reservedAdd.run(f.client, {
		steamId: '76561198000000003',
		viaConfig: true
	});
	expect(r.via).toBe('config');
	expect(f.text()).toContain('.DefaultReservedPlayerIds=76561198000000003');
	expect(f.text()).toContain('MaxReservedSlots=2');
});

test('a revision conflict is retried once with the fresh revision, then reported as 412', async () => {
	let f = reservedClient({ route: false, text: `${SESSION}\n`, conflicts: 1 });
	const r: any = await ACTIONS.reservedAdd.run(f.client, { steamId: ID, viaConfig: true });
	expect(f.calls).toEqual([
		'GET /v1/config',
		'PUT /v1/config r1',
		'GET /v1/config',
		'PUT /v1/config r2',
		'GET /v1/reserved-slots'
	]);
	expect(r.revision).toBe('r3');

	f = reservedClient({ route: false, text: `${SESSION}\n`, conflicts: 2 });
	await expect(
		ACTIONS.reservedAdd.run(f.client, { steamId: ID, viaConfig: true })
	).rejects.toMatchObject({ status: 412, code: 'revision_conflict' });
});

test('a read-only document and a real route error are reported, not worked around', async () => {
	let f = reservedClient({ route: false, text: `${SESSION}\n`, writable: false });
	await expect(ACTIONS.reservedAdd.run(f.client, { steamId: ID })).rejects.toMatchObject({
		status: 400,
		code: 'config_readonly'
	});

	f = reservedClient({
		route: true,
		text: `${SESSION}\n`,
		routeError: new GameError(401, 'Unauthorized.', 'unauthorized')
	});
	await expect(ACTIONS.reservedAdd.run(f.client, { steamId: ID })).rejects.toMatchObject({
		status: 401
	});
	expect(f.calls).toEqual(['POST /v1/reserved-slots']);
});

test('config takes the revision from the body, or from the ETag when the body lacks it', async () => {
	const doc = {
		writable: true,
		text: '[/Script/WDGame.WDGameSession]\n',
		sections: [],
		warnings: []
	};
	const client: any = {
		raw: async () => ({
			status: 200,
			statusText: 'OK',
			headers: { etag: '"d31a26d94a9c"' },
			text: JSON.stringify(doc)
		})
	};
	expect(((await ACTIONS.config.run(client, {})) as any).revision).toBe('d31a26d94a9c');
	client.raw = async () => ({
		status: 200,
		statusText: 'OK',
		headers: { etag: '"other"' },
		text: JSON.stringify({ ...doc, revision: 'body1' })
	});
	expect(((await ACTIONS.config.run(client, {})) as any).revision).toBe('body1');
	client.raw = async () => ({
		status: 429,
		statusText: '',
		headers: { 'retry-after': '3' },
		text: JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } })
	});
	await expect(ACTIONS.config.run(client, {})).rejects.toMatchObject({
		status: 429,
		code: 'rate_limited',
		retryAfterMs: 3000
	});
});

test('config refuses anything that is not a document, so nothing is ever PUT over a real file', async () => {
	const answer =
		(text: string, headers: Record<string, string> = {}) =>
		async () => ({
			status: 200,
			statusText: 'OK',
			headers,
			text
		});
	const client: any = { raw: answer('{}') };
	await expect(ACTIONS.config.run(client, {})).rejects.toMatchObject({
		status: 502,
		code: 'bad_response'
	});
	client.raw = answer('<html>proxy login</html>');
	await expect(ACTIONS.config.run(client, {})).rejects.toMatchObject({ code: 'bad_response' });
	// A body without a revision is fine when the ETag carries it.
	client.raw = answer(JSON.stringify({ text: '', sections: [] }), { etag: '"abc"' });
	expect(((await ACTIONS.config.run(client, {})) as any).revision).toBe('abc');
	client.raw = answer(JSON.stringify({ text: '', sections: [] }));
	await expect(ACTIONS.config.run(client, {})).rejects.toMatchObject({ code: 'bad_response' });
	// And the reserved-slot path stops before any PUT.
	const calls: string[] = [];
	const bad: any = {
		json: async () => {
			throw new GameError(404, 'no', 'no_route');
		},
		raw: async (m: string, p: string) => {
			calls.push(`${m} ${p}`);
			return { status: 200, statusText: 'OK', headers: {}, text: '{}' };
		},
		configCall: async (m: string, p: string) => {
			calls.push(`${m} ${p}`);
			return { status: 200, body: { ok: true }, etag: '' };
		}
	};
	await expect(ACTIONS.reservedAdd.run(bad, { steamId: ID })).rejects.toMatchObject({
		code: 'bad_response'
	});
	expect(calls).toEqual(['GET /v1/config']);
});

test('a refused PUT is classified (a missing route stays no_route) and carries no body', async () => {
	const f = reservedClient({ route: false, text: `${SESSION}\n` });
	f.client.configCall = async () => ({
		status: 404,
		body: { error: { code: 'not_found', message: 'No such endpoint.' } },
		etag: ''
	});
	const err: any = await ACTIONS.reservedAdd
		.run(f.client, { steamId: ID, viaConfig: true })
		.catch((e) => e);
	expect(err.code).toBe('no_route');
	expect(err.body).toBeNull();
	const g = reservedClient({ route: false, text: `${SESSION}\n`, conflicts: 2 });
	const conflict: any = await ACTIONS.reservedAdd
		.run(g.client, { steamId: ID, viaConfig: true })
		.catch((e) => e);
	expect(conflict.code).toBe('revision_conflict');
	expect(conflict.body).toBeNull();
});

// The document carries the RCON password. It leaves the panel without it, for every role, and
// comes back with it: whoever holds the password runs the server without the panel.
const RCON = '[/Script/WDRCON.WDRCONSettings]';
const WITH_SECRETS = `${SESSION}\r\nServerName=x\r\n!DefaultReservedPlayerIds=ClearArray\r\n\r\n${RCON}\r\nPassword=hunter2\r\n\r\n[WDServerFeed]\r\nToken=wcf_abc\r\n`;

test('config hides the RCON password and the feed token from whoever reads it', async () => {
	const f = reservedClient({ route: false, text: WITH_SECRETS });
	const r: any = await ACTIONS.config.run(f.client, {});
	expect(r.text).not.toContain('hunter2');
	expect(r.text).not.toContain('wcf_abc');
	expect(r.text).toContain('Password=(hidden)');
	expect(r.text).toContain('ServerName=x');
	expect(r.revision).toBe('r1');
});

test('configApply puts the live credentials back where the placeholder was left alone', async () => {
	const f = reservedClient({ route: false, text: WITH_SECRETS });
	const shown = ((await ACTIONS.config.run(f.client, {})) as any).text as string;
	await ACTIONS.configApply.run(f.client, {
		text: shown.replace('ServerName=x', 'ServerName=y'),
		revision: 'r1'
	});
	expect(f.text()).toBe(WITH_SECRETS.replace('ServerName=x', 'ServerName=y'));
	// A typed password is the caller's, and a document without placeholders costs no extra read.
	f.calls.length = 0;
	await ACTIONS.configApply.run(f.client, {
		text: WITH_SECRETS.replace('hunter2', 'rotated'),
		revision: 'r2'
	});
	expect(f.calls).toEqual(['PUT /v1/config r2']);
	expect(f.text()).toContain('Password=rotated');
});

test('configValidate checks the document the server would get, not the placeholders', async () => {
	const f = reservedClient({ route: false, text: WITH_SECRETS });
	const shown = ((await ACTIONS.config.run(f.client, {})) as any).text as string;
	let validated = '';
	f.client.configCall = async (_m: string, _p: string, body: string) => {
		validated = body;
		return { status: 200, body: { ok: true } };
	};
	await ACTIONS.configValidate.run(f.client, { text: shown });
	expect(validated).toBe(WITH_SECRETS);
});

test('what the game says about a document never quotes a credential back', async () => {
	const f = reservedClient({ route: false, text: WITH_SECRETS });
	const shown = ((await ACTIONS.config.run(f.client, {})) as any).text as string;
	// A build that echoes lines: nothing documented does, and nothing says one never will.
	const echo = {
		ok: true,
		changed: [{ key: 'Password', from: 'hunter2', to: 'hunter2' }],
		warnings: ['line 7: Password=hunter2 is short', 'Token=wcf_abc unused']
	};
	f.client.configCall = async () => ({ status: 200, body: echo });
	for (const action of [ACTIONS.configValidate, ACTIONS.configApply]) {
		const told = JSON.stringify(await action.run(f.client, { text: shown, revision: 'r1' }));
		expect(told).not.toContain('hunter2');
		expect(told).not.toContain('wcf_abc');
		expect(told).toContain('Password=(hidden) is short');
	}
	// A refused apply carries the game's answer as the error's body, and a conflict names the
	// live side, which may be a password this document never held.
	f.client.configCall = async () => ({
		status: 400,
		body: { ok: false, error: { message: 'bad line: Password=hunter2' }, errors: ['hunter2'] }
	});
	const refused: any = await ACTIONS.configApply
		.run(f.client, { text: shown, revision: 'r1' })
		.catch((e) => e);
	expect(refused.message).not.toContain('hunter2');
	expect(JSON.stringify(refused.body)).not.toContain('hunter2');
	f.client.configCall = async () => ({
		status: 412,
		body: { conflict: [{ line: 'Password=hunter2' }] }
	});
	const conflict = await ACTIONS.configApply.run(f.client, {
		text: WITH_SECRETS.replace('hunter2', 'typed-by-me'),
		revision: 'r0'
	});
	expect(JSON.stringify(conflict)).not.toContain('hunter2');
});

test('a reserved slot the document refuses says so without quoting a credential', async () => {
	const f = reservedClient({ route: false, text: WITH_SECRETS, live: [] });
	f.client.configCall = async () => ({
		status: 400,
		body: { error: { code: 'invalid', message: 'bad line: Password=hunter2' } }
	});
	const refused: any = await ACTIONS.reservedAdd.run(f.client, { steamId: ID }).catch((e) => e);
	expect(refused.message).toBe('bad line: Password=(hidden)');
	expect(refused.body).toBeNull();
});

test('a placeholder the server has no value for is refused before anything is written', async () => {
	const f = reservedClient({ route: false, text: `${SESSION}\r\nServerName=x\r\n` });
	await expect(
		ACTIONS.configApply.run(f.client, { text: `${RCON}\r\nPassword=(hidden)\r\n`, revision: 'r1' })
	).rejects.toMatchObject({ status: 400, code: 'hidden_value' });
	expect(f.calls).toEqual(['GET /v1/config']);
});

test('a reserved slot written through the document keeps the real password in the file', async () => {
	const f = reservedClient({ route: false, text: WITH_SECRETS, live: [] });
	await ACTIONS.reservedAdd.run(f.client, { steamId: ID });
	expect(f.text()).toContain('Password=hunter2');
	expect(f.text()).toContain('Token=wcf_abc');
	expect(f.text()).toContain(ID);
});

test('raw does not serve the config document, however the path is spelt', async () => {
	const calls: string[] = [];
	const client: any = {
		raw: async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			return { status: 200, statusText: 'OK', headers: {}, text: '{}' };
		}
	};
	for (const path of [
		'/v1/config',
		'/v1/config?x=1',
		'/v1/Config',
		'/v1/config.',
		'/v1/config/validate'
	])
		await expect(ACTIONS.raw.run(client, { method: 'GET', path })).rejects.toMatchObject({
			status: 403,
			code: 'use_config_actions'
		});
	for (const path of ['/v1/audit', '/v1/audit?limit=500', '/v1/AUDIT.'])
		await expect(ACTIONS.raw.run(client, { method: 'GET', path })).rejects.toMatchObject({
			status: 403,
			code: 'use_server_log'
		});
	// A listener that reads an escape, a ';' or a second layer of encoding its own way would serve
	// the document for these, so a route with anything but plain characters is not sent at all.
	for (const path of [
		'/v1/%63onfig',
		'/v1/%61udit',
		'/v1/config%3Fx',
		'/v1/config%23x',
		'/v1/config;x',
		'/v1/config%20',
		'/v1/config%00',
		'/v1/config%5c',
		'/v1/%2563onfig',
		'/v1/%63onfig/%ZZ'
	])
		await expect(ACTIONS.raw.run(client, { method: 'GET', path })).rejects.toMatchObject({
			status: 400
		});
	expect(calls).toEqual([]);
	await ACTIONS.raw.run(client, { method: 'GET', path: '/v1/configuration' });
	await ACTIONS.raw.run(client, { method: 'GET', path: '/v1/status' });
	await ACTIONS.raw.run(client, { method: 'GET', path: '/v1/players?name=a%20b' });
	expect(calls).toEqual(['GET /v1/configuration', 'GET /v1/status', 'GET /v1/players?name=a%20b']);
});

test('raw passes on the documented headers only: a proxy in front of the listener names the RCON address in the others', async () => {
	const client: any = {
		raw: async () => ({
			status: 301,
			statusText: 'Moved',
			headers: {
				'content-type': 'text/html',
				etag: '"abc"',
				location: 'https://rcon.example.net:7776/v1/status/',
				via: '1.1 rcon.example.net',
				'alt-svc': 'h3="rcon.example.net:7776"'
			},
			text: ''
		})
	};
	const res: any = await ACTIONS.raw.run(client, { method: 'GET', path: '/v1/status' });
	expect(res.headers).toEqual({ 'content-type': 'text/html', etag: '"abc"' });
});

test('status keeps only safe faction colours, names and scores from the game', async () => {
	const client: any = {
		json: async () => ({
			map: 'Ozeti',
			players: { current: 3, max: 64 },
			factionScores: [
				{ name: 'Valkyra', colorHex: '#D86060', score: 34 },
				{ name: 'Lonestar', colorHex: 'red;background:url(https://evil.example/b)', score: 'abc' }
			]
		})
	};
	const status = (await ACTIONS.status.run(client, {})) as {
		scores: { name: string; colorHex: string; score: number }[];
	};
	expect(status.scores).toEqual([
		{ name: 'Valkyra', colorHex: '#D86060', score: 34 },
		{ name: 'Lonestar', colorHex: '', score: 0 }
	]);
});

// ---- group whispers ----------------------------------------------------------------------------

const { GROUP_BUDGET, GROUP_MS } = await import('./actions');
const { classifyGameError } = await import('./rcon');
const { resetRates } = await import('./ratelimit');

const sid = (n: number) => `765611980000${String(n).padStart(5, '0')}`;
const rateLimited = () =>
	classifyGameError(
		'POST',
		'/v1/players/x/message',
		429,
		'',
		{ error: { code: 'rate_limited', message: 'Too many requests from this address.' } },
		{ 'retry-after': '3' }
	);

/**
 * A stand-in game for group whispers: the roster it lists, and per whisper what it answers (an
 * error to throw, or nothing for delivered). `server` keys the budget, so tests do not share it.
 */
function groupGame(
	server: string,
	roster: { steamId: string; faction: string | null }[],
	answer: (steamId: string) => Error | null = () => null
) {
	const calls: string[] = [];
	const bodies: unknown[] = [];
	const client: any = {
		serverId: server,
		json: async (method: string, path: string, body?: unknown) => {
			calls.push(`${method} ${path}`);
			if (path === '/v1/players') return { players: roster.map((p) => ({ name: 'x', ...p })) };
			bodies.push(body);
			const err = answer(path.split('/')[3]);
			if (err) throw err;
			return { message: 'Message sent.' };
		}
	};
	const whispered = () => calls.filter((c) => c.startsWith('POST ')).map((c) => c.split('/')[3]);
	return { client, calls, bodies, whispered };
}

const ROSTER = [
	{ steamId: sid(1), faction: 'Valkyra' },
	{ steamId: sid(2), faction: 'Lonestar' },
	{ steamId: sid(3), faction: 'Valkyra' },
	{ steamId: sid(4), faction: null },
	{ steamId: sid(5), faction: 'Valkyra' }
];

test('whisperMany whispers everyone on the faction when it runs, and no one else', async () => {
	const g = groupGame('g1', ROSTER);
	const r: any = await ACTIONS.whisperMany.run(g.client, {
		faction: 'Valkyra',
		message: ' Push B '
	});
	expect(g.calls[0]).toBe('GET /v1/players');
	expect(g.whispered()).toEqual([sid(1), sid(3), sid(5)]);
	expect(g.bodies).toEqual([{ message: 'Push B' }, { message: 'Push B' }, { message: 'Push B' }]);
	expect(r).toEqual({
		message: 'Whispered 3 players on Valkyra.',
		sent: [sid(1), sid(3), sid(5)],
		absent: [],
		unsent: []
	});
});

test('whisperMany whispers each SteamID named once, and says who is not on', async () => {
	const g = groupGame('g2', ROSTER);
	const r: any = await ACTIONS.whisperMany.run(g.client, {
		steamIds: [sid(2), sid(9), sid(4), sid(2)],
		message: 'Hi'
	});
	expect(g.whispered()).toEqual([sid(2), sid(4)]);
	expect(r.sent).toEqual([sid(2), sid(4)]);
	expect(r.absent).toEqual([sid(9)]);
	expect(r.message).toBe('Whispered 2 of 3 players; 1 not on the server.');
});

test('a player gone by their turn is passed over, and the rest still get it', async () => {
	const g = groupGame('g3', ROSTER, (id) =>
		id === sid(3) ? new GameError(404, `Player not found: ${id}`, 'player_not_found') : null
	);
	const r: any = await ACTIONS.whisperMany.run(g.client, { faction: 'Valkyra', message: 'Hi' });
	expect(g.whispered()).toEqual([sid(1), sid(3), sid(5)]);
	expect(r.sent).toEqual([sid(1), sid(5)]);
	expect(r.absent).toEqual([sid(3)]);
	expect(r.unsent).toEqual([]);
	expect(r.stopped).toBeUndefined();
});

test('a refusal ends the run: nothing after it is sent, nothing is sent twice, and the answer says so', async () => {
	const g = groupGame('g4', ROSTER, (id) => (id === sid(3) ? rateLimited() : null));
	const r: any = await ACTIONS.whisperMany.run(g.client, { faction: 'Valkyra', message: 'Hi' });
	expect(g.whispered()).toEqual([sid(1), sid(3)]);
	expect(r.sent).toEqual([sid(1)]);
	expect(r.unsent).toEqual([sid(3), sid(5)]);
	expect(r.retryAfterMs).toBe(3000);
	expect(r.stopped).toContain('rate limiting');
	expect(r.message).toMatch(
		/^Whispered 1 of 3 players on Valkyra; 2 not sent\. The game server is rate limiting this panel .*retry in 3 s\.$/
	);
});

test("a refusal before anyone got it is the game's own error", async () => {
	const g = groupGame(
		'g5',
		ROSTER,
		() => new GameError(502, 'Could not reach the game server.', 'unreachable')
	);
	await expect(
		ACTIONS.whisperMany.run(g.client, { faction: 'Valkyra', message: 'Hi' })
	).rejects.toMatchObject({ status: 502, code: 'unreachable' });
	expect(g.whispered()).toEqual([sid(1)]);
});

test('nobody to whisper is a 404 before any whisper goes out', async () => {
	const nobody = groupGame('g6', ROSTER);
	await expect(
		ACTIONS.whisperMany.run(nobody.client, { faction: 'Manticore', message: 'Hi' })
	).rejects.toMatchObject({ status: 404, code: 'no_recipients' });
	await expect(
		ACTIONS.whisperMany.run(nobody.client, { steamIds: [sid(8), sid(9)], message: 'Hi' })
	).rejects.toMatchObject({ status: 404, code: 'no_recipients' });
	expect(nobody.whispered()).toEqual([]);
	const allGone = groupGame(
		'g7',
		ROSTER,
		(id) => new GameError(404, `Player not found: ${id}`, 'player_not_found')
	);
	await expect(
		ACTIONS.whisperMany.run(allGone.client, { steamIds: [sid(1)], message: 'Hi' })
	).rejects.toMatchObject({ status: 404, code: 'no_recipients' });
});

test('whisperMany refuses what it cannot send before asking the game anything', async () => {
	const g = groupGame('g8', ROSTER);
	const bad = [
		{ faction: 'Valkyra' },
		{ faction: 'Valkyra', message: '   ' },
		{ message: 'Hi' },
		{ message: 'Hi', faction: 'Valkyra', steamIds: [sid(1)] },
		{ message: 'Hi', faction: '  ' },
		{ message: 'Hi', steamIds: [] },
		{ message: 'Hi', steamIds: sid(1) },
		{ message: 'Hi', steamIds: [sid(1), '123'] },
		{ message: 'Hi', steamIds: [sid(1), '../../config'] },
		{ message: 'Hi', steamIds: [JSON.parse('76561198100000101')] },
		{ message: 'Hi', steamIds: Array.from({ length: 201 }, (_, i) => sid(i)) }
	];
	for (const p of bad)
		await expect(ACTIONS.whisperMany.run(g.client, p)).rejects.toMatchObject({ status: 400 });
	expect(g.calls).toEqual([]);
});

test('a group whisper starts no whisper once its time is up, and says how many it left', async () => {
	let now = Date.now();
	const clock = spyOn(Date, 'now').mockImplementation(() => now);
	try {
		const many = Array.from({ length: 8 }, (_, i) => ({
			steamId: sid(100 + i),
			faction: 'Lonestar'
		}));
		const g = groupGame('g9', many);
		// Every request takes three seconds of the fake clock: the read, then whispers at 3, 6 and 9.
		const json = g.client.json;
		g.client.json = async (...a: unknown[]) => {
			now += 3000;
			return json(...a);
		};
		const r: any = await ACTIONS.whisperMany.run(g.client, { faction: 'Lonestar', message: 'Hi' });
		expect(g.whispered().length).toBe(3);
		expect(r.unsent.length).toBe(5);
		expect(r.stopped).toBe(`Stopped after ${GROUP_MS / 1000} s.`);
		expect(r.message).toBe(
			`Whispered 3 of 8 players on Lonestar; 5 not sent. Stopped after ${GROUP_MS / 1000} s.`
		);
	} finally {
		clock.mockRestore();
	}
});

test('a server takes GROUP_BUDGET players whispered in groups a minute; other servers are not held', async () => {
	resetRates();
	const full = Array.from({ length: GROUP_BUDGET / 2 }, (_, i) => ({
		steamId: sid(1000 + i),
		faction: 'Valkyra'
	}));
	const g = groupGame('g10', full);
	await ACTIONS.whisperMany.run(g.client, { faction: 'Valkyra', message: 'Hi' });
	await ACTIONS.whisperMany.run(g.client, { faction: 'Valkyra', message: 'Hi' });
	expect(g.whispered().length).toBe(GROUP_BUDGET);
	await expect(
		ACTIONS.whisperMany.run(g.client, { steamIds: [sid(1000)], message: 'Hi' })
	).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
	expect(g.whispered().length).toBe(GROUP_BUDGET);
	const other = groupGame('g11', full);
	await ACTIONS.whisperMany.run(other.client, { faction: 'Valkyra', message: 'Hi' });
	expect(other.whispered().length).toBe(GROUP_BUDGET / 2);
	resetRates();
});

test('whispers a stopped run never tried go back to the budget, so refusals cannot use it up', async () => {
	resetRates();
	const full = Array.from({ length: GROUP_BUDGET / 2 }, (_, i) => ({
		steamId: sid(2000 + i),
		faction: 'Lonestar'
	}));
	// The game takes the first whisper of each run and refuses the second.
	let n = 0;
	const g = groupGame('g12', full, () => (n++ % 2 === 1 ? rateLimited() : null));
	for (let run = 0; run < 5; run++) {
		const r: any = await ACTIONS.whisperMany.run(g.client, { faction: 'Lonestar', message: 'Hi' });
		expect(r.sent.length).toBe(1);
		expect(r.unsent.length).toBe(GROUP_BUDGET / 2 - 1);
	}
	// A game refusing the very first whisper: its error, and only that request counted.
	const shut = groupGame('g12', full, () => rateLimited());
	for (let run = 0; run < 5; run++)
		await expect(
			ACTIONS.whisperMany.run(shut.client, { faction: 'Lonestar', message: 'Hi' })
		).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
	// 5 x 2 + 5 x 1 requests counted: a whole faction still fits.
	const open = groupGame('g12', full);
	const r: any = await ACTIONS.whisperMany.run(open.client, { faction: 'Lonestar', message: 'Hi' });
	expect(r.sent.length).toBe(GROUP_BUDGET / 2);
	resetRates();
});

test('the trail keeps the faction, or the SteamIDs, as the target', () => {
	const target = ACTIONS.whisperMany.target!;
	expect(target({ faction: 'Valkyra', message: 'Hi' })).toBe('Valkyra');
	expect(target({ steamIds: [sid(1), sid(2)], message: 'Hi' })).toBe(`${sid(1)} ${sid(2)}`);
	expect(target({ message: 'Hi' })).toBe('');
});

// ---- chat length ------------------------------------------------------------------------------

test('a whisper, a broadcast and a group whisper carry up to 256 characters; a kick reason 200', async () => {
	const sent: { path: string; body: any }[] = [];
	const client: any = {
		serverId: 'chat-cap',
		json: async (method: string, path: string, body?: unknown) => {
			if (path === '/v1/players')
				return { players: [{ name: 'x', steamId: sid(1), faction: 'Valkyra' }] };
			sent.push({ path, body });
			return { message: 'ok' };
		}
	};
	const long = 'm'.repeat(400);
	await ACTIONS.broadcast.run(client, { message: long });
	await ACTIONS.whisper.run(client, { steamId: sid(1), message: long });
	await ACTIONS.whisperMany.run(client, { steamIds: [sid(1)], message: long });
	await ACTIONS.kick.run(client, { steamId: sid(1), reason: long });
	expect(
		sent.map((s) => [s.path.split('/').at(-1), (s.body.message ?? s.body.reason).length])
	).toEqual([
		['broadcast', 256],
		['message', 256],
		['message', 256],
		['kick', 200]
	]);
	expect(ACTIONS.broadcast.target!({ message: long })).toHaveLength(256);
	resetRates();
});

test('the live build refuses 257 characters, and the broadcast action never sends that many', async () => {
	const { WardogsClient } = await import('./rcon');
	const before = process.env.MOCK_LIVE_BUILD;
	process.env.MOCK_LIVE_BUILD = 'true';
	try {
		const server = { id: 'chat-live', host: 'demo', port: 1, scheme: 'http' as const };
		const client = new WardogsClient({} as any, server, 'demo', 'chat-live');
		const sent = (n: number) =>
			client.raw('POST', '/v1/broadcast', JSON.stringify({ message: 'x'.repeat(n) }), {
				'Content-Type': 'application/json'
			});
		expect((await sent(256)).status).toBe(200);
		const refused = await sent(257);
		expect(refused.status).toBe(400);
		expect(JSON.parse(refused.text).error.code).toBe('message_too_long');
		const r: any = await ACTIONS.broadcast.run(client, { message: 'x'.repeat(400) });
		expect(r.message).toContain('Announcement sent');
	} finally {
		if (before === undefined) delete process.env.MOCK_LIVE_BUILD;
		else process.env.MOCK_LIVE_BUILD = before;
	}
});

// ---- next map on a live build -----------------------------------------------------------------

// The live builds read the rotation but serve none of its edit routes, so the panel disables Play
// next and Set as next map there (issue #50). The action itself has no other way to queue a map.
test('setNextMap on the live build answers 404 no_route and leaves the rotation as it was', async () => {
	const { WardogsClient } = await import('./rcon');
	const before = process.env.MOCK_LIVE_BUILD;
	process.env.MOCK_LIVE_BUILD = 'true';
	try {
		const server = { id: 'next-live', host: 'demo', port: 1, scheme: 'http' as const };
		const client = new WardogsClient({} as any, server, 'demo', 'next-live');
		const rotation: any = await ACTIONS.rotation.run(client, {});
		expect(rotation.entries.length).toBeGreaterThan(2);
		// one already in the rotation (moved up) and one that is not (added, then moved)
		const picks = [rotation.entries.at(-1), { map: 'Europe', experiences: ['KOTH_Hardcore'] }];
		for (const sel of picks) {
			const err: any = await ACTIONS.setNextMap.run(client, sel).catch((e) => e);
			expect(err).toBeInstanceOf(GameError);
			expect([err.status, err.code]).toEqual([404, 'no_route']);
		}
		expect(await ACTIONS.rotation.run(client, {})).toEqual(rotation);
	} finally {
		if (before === undefined) delete process.env.MOCK_LIVE_BUILD;
		else process.env.MOCK_LIVE_BUILD = before;
	}
});
