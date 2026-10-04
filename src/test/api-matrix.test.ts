// Every route under src/routes/api, asked by every member of the cast. The table below is the
// permission model in one place: a route that is not in it fails the first test, and a route
// whose check drifts from its line fails the matrix. Handlers are called directly with a real
// database behind them; the game server is a stub, so "ok" means the check let the request by.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Env } from '$lib/server/env';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { expected, outcomeOf, type Policy } from './policy';
import { LIST_KINDS } from '$lib/server/lists';
import type { ListKind } from '$lib/types';
import { PRINCIPALS, seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');

/**
 * Answered without the cast, because who may call them is not a matter of roles: a feed token, a
 * metrics token, a public-page switch, a WebAuthn ceremony. Each has tests of its own.
 */
const NOT_ROLE_BASED = [
	'GET api/health',
	'POST api/ingest/events',
	'POST api/passkeys',
	'POST api/passkeys/auth-options',
	'POST api/passkeys/auth',
	'POST api/passkeys/register-options',
	'GET api/public/servers/[id]',
	'GET api/public/servers/[id]/leaderboard',
	'GET api/public/servers/[id]/matches',
	'GET api/public/servers/[id]/matches/[matchId]',
	'GET api/public/servers/[id]/players/[steamId]',
	'GET auth/steam/callback',
	'GET metrics',
	'GET sign-out',
	'POST sign-out'
];

/** A route under [kind] answers as the list it names: its line runs once per list, as `lists:<kind>`. */
const PER_LIST = 'lists:[kind]';

const MATRIX: Record<string, Policy | typeof PER_LIST> = {
	'GET api/actions': 'user',
	'GET api/audit': 'user',
	'GET api/audit/export': 'user',
	'GET api/audit/meta': 'user',
	'GET api/live': 'user',
	'GET api/live/events': 'user',
	'GET api/steam/profiles': 'anyServer',
	'GET api/passkeys': 'user',
	'DELETE api/passkeys/[id]': 'user',
	'PUT api/scope': 'person',
	'DELETE api/scope': 'person',

	// the panel
	'GET api/admin/overview': 'site',
	'GET api/settings': 'site',
	'PUT api/settings': 'site',
	'GET api/users': 'site',
	'POST api/users': 'site',
	'PATCH api/users/[id]': 'site',
	'DELETE api/users/[id]': 'site',
	'PUT api/users/[id]/grants': 'site',

	// an organisation
	'GET api/orgs': 'user',
	'POST api/orgs': 'person',
	'PATCH api/orgs/[id]': 'orgOwner',
	'DELETE api/orgs/[id]': 'orgOwner',
	'GET api/orgs/[id]/invites': 'orgOwner',
	'POST api/orgs/[id]/invites': 'orgOwner',
	'DELETE api/orgs/[id]/invites/[inviteId]': 'orgOwner',
	'GET api/orgs/[id]/keys': 'orgOwner',
	'POST api/orgs/[id]/keys': 'orgOwner',
	'DELETE api/orgs/[id]/keys/[keyId]': 'orgOwner',
	'GET api/orgs/[id]/members': 'orgOwner',
	'PATCH api/orgs/[id]/members/[userId]': 'orgOwner',
	'DELETE api/orgs/[id]/members/[userId]': 'orgOwner',
	'PUT api/orgs/[id]/members/[userId]/grants': 'orgOwner',
	'GET api/orgs/[id]/roles': 'orgOwner',
	'POST api/orgs/[id]/roles': 'orgOwner',
	'PUT api/orgs/[id]/roles/order': 'orgOwner',
	'PATCH api/orgs/[id]/roles/[roleId]': 'orgOwner',
	'DELETE api/orgs/[id]/roles/[roleId]': 'orgOwner',
	'POST api/orgs/[id]/roles/[roleId]/reset': 'orgOwner',
	'GET api/orgs/[id]/webhooks': 'orgOwner',
	'POST api/orgs/[id]/webhooks': 'orgOwner',
	'PATCH api/orgs/[id]/webhooks/[webhookId]': 'orgOwner',
	'DELETE api/orgs/[id]/webhooks/[webhookId]': 'orgOwner',
	'POST api/orgs/[id]/webhooks/[webhookId]/card': 'orgOwner',
	'POST api/orgs/[id]/webhooks/[webhookId]/test': 'orgOwner',
	'GET api/orgs/[id]/json-webhooks': 'orgOwner',
	'POST api/orgs/[id]/json-webhooks': 'orgOwner',
	'PATCH api/orgs/[id]/json-webhooks/[webhookId]': 'orgOwner',
	'DELETE api/orgs/[id]/json-webhooks/[webhookId]': 'orgOwner',
	'POST api/orgs/[id]/json-webhooks/[webhookId]/test': 'orgOwner',

	// its ban and reserved-slot lists
	'GET api/orgs/[id]/lists': 'lists',
	'GET api/orgs/[id]/lists/[kind]/entries': PER_LIST,
	'POST api/orgs/[id]/lists/[kind]/entries': PER_LIST,
	'PATCH api/orgs/[id]/lists/[kind]/entries/[steamId]': PER_LIST,
	'DELETE api/orgs/[id]/lists/[kind]/entries/[steamId]': PER_LIST,
	'GET api/orgs/[id]/lists/import': 'listsOwner',
	'POST api/orgs/[id]/lists/import': 'listsOwner',
	'POST api/orgs/[id]/lists/sync': 'lists',
	'GET api/orgs/[id]/players': 'lists',

	// a server: run by its org's owners
	'GET api/servers': 'user',
	'POST api/servers': 'orgOwner',
	'PATCH api/servers/[id]': 'manager',
	'DELETE api/servers/[id]': 'manager',
	'POST api/servers/[id]/feed': 'manager',
	'DELETE api/servers/[id]/feed': 'manager',
	'POST api/servers/[id]/stats/purge': 'manager',
	'GET api/servers/[id]/grants': 'manager',
	'PUT api/servers/[id]/grants': 'manager',

	// a server: by capability
	'GET api/servers/[id]/analytics': 'cap:server.view',
	'GET api/servers/[id]/analytics/periods': 'cap:server.view',
	'GET api/servers/[id]/cash': 'cap:server.view',
	'GET api/servers/[id]/feed': 'cap:server.view',
	'GET api/servers/[id]/events': 'cap:server.view',
	'GET api/servers/[id]/kills': 'cap:server.view',
	'GET api/servers/[id]/leaderboard': 'cap:server.view',
	'GET api/servers/[id]/leaderboard/export': 'cap:server.view',
	'GET api/servers/[id]/matches': 'cap:server.view',
	'GET api/servers/[id]/matches/[matchId]': 'cap:server.view',
	'GET api/servers/[id]/lists/state': 'cap:server.view',
	'GET api/servers/[id]/players/[steamId]': 'cap:server.view',
	'GET api/servers/[id]/players/[steamId]/career': 'cap:server.view',
	'POST api/servers/[id]/players/[steamId]/steam': 'cap:server.view',
	'GET api/servers/[id]/players/marks': 'cap:server.view',
	'GET api/servers/[id]/players/seen': 'cap:server.view',
	'GET api/servers/[id]/summary': 'cap:server.view',
	'POST api/servers/[id]/players/[steamId]/notes': 'cap:players.notes',
	'DELETE api/servers/[id]/players/[steamId]/notes/[noteId]': 'cap:players.notes',
	'PUT api/servers/[id]/players/[steamId]/watch': 'cap:players.notes',
	'POST api/servers/[id]/lists/ban/entries': 'cap:bans.manage',
	'PATCH api/servers/[id]/lists/ban/entries/[steamId]': 'cap:bans.manage',
	'DELETE api/servers/[id]/lists/ban/entries/[steamId]': 'cap:bans.manage',
	'POST api/servers/[id]/lists/reserve/entries': 'cap:slots.manage',
	'DELETE api/servers/[id]/lists/reserve/entries/[steamId]': 'cap:slots.manage',
	'POST api/servers/[id]/lists/sync': 'listsHere',
	'POST api/servers/[id]/test': 'cap:config.apply',
	'GET api/servers/[id]/outbox': 'cap:automation.manage',
	'GET api/servers/[id]/triggers': 'cap:automation.manage',
	'POST api/servers/[id]/triggers': 'cap:automation.manage',
	'PATCH api/servers/[id]/triggers/[triggerId]': 'cap:automation.manage',
	'DELETE api/servers/[id]/triggers/[triggerId]': 'cap:automation.manage',
	'POST api/servers/[id]/triggers/dry-run': 'cap:automation.manage'
};

/** Game actions go through one route; each is a line of its own in actions.test's table. */
const ACTION_ROUTE = ['GET api/servers/[id]/rcon/[action]', 'POST api/servers/[id]/rcon/[action]'];

/** Rows whose allowed callers destroy what the next caller needs: a new world for each of them. */
const FRESH_EACH = new Set(['DELETE api/orgs/[id]', 'DELETE api/servers/[id]']);

const STEAM_ID = '76561198000000001';

function paramsFor(path: string, w: World, kind: ListKind): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [, name] of path.matchAll(/\[(\w+)\]/g)) {
		if (name === 'id')
			out.id = path.startsWith('api/servers/')
				? w.server.id
				: path.startsWith('api/orgs/')
					? w.org.id
					: 'nobody';
		else if (name === 'steamId') out.steamId = STEAM_ID;
		else if (name === 'kind') out.kind = kind;
		else out[name] = 'nothing';
	}
	return out;
}

const bodyFor = (key: string, w: World): unknown =>
	key === 'POST api/servers'
		? { orgId: w.org.id }
		: key.endsWith('/card')
			? { serverId: w.server.id }
			: {};

function routeFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? routeFiles(join(dir, e.name))
			: e.name === '+server.ts'
				? [join(dir, e.name)]
				: []
	);
}

const onDisk = routeFiles(ROUTES).flatMap((file) => {
	const path = relative(ROUTES, join(file, '..'));
	const methods = readFileSync(file, 'utf8').matchAll(
		/^export const (GET|POST|PUT|PATCH|DELETE)\b/gm
	);
	return [...methods].map((m) => `${m[1]} ${path}`);
});

test('every route has a line in the matrix', () => {
	const listed = [...Object.keys(MATRIX), ...NOT_ROLE_BASED, ...ACTION_ROUTE].sort();
	expect(listed).toEqual([...onDisk].sort());
});

describe.skipIf(!hasTestDb)('API permission matrix', () => {
	let env: Env;
	let reads: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		reads = await seedWorld(env);
	});

	const runs = Object.entries(MATRIX).flatMap(([key, line]) =>
		line === PER_LIST
			? LIST_KINDS.map((kind) => ({ key, kind, policy: `lists:${kind}` as Policy }))
			: [{ key, kind: 'ban' as ListKind, policy: line }]
	);
	for (const { key, kind, policy } of runs) {
		const [method, path] = key.split(' ');
		test(`${key.replace('[kind]', kind)} is ${policy}`, async () => {
			const mod = await import(join(ROUTES, path, '+server.ts'));
			let world = method === 'GET' ? reads : await seedWorld(env);
			const got: Record<string, unknown> = {};
			const want: Record<string, unknown> = {};
			for (const who of PRINCIPALS) {
				want[who] = expected(policy, who);
				if (FRESH_EACH.has(key) && want[who] === 'ok') world = await seedWorld(env);
				const answer = await callApi(mod[method], world.users[who], {
					method,
					params: paramsFor(path, world, kind),
					body: bodyFor(key, world)
				});
				got[who] = outcomeOf(answer);
			}
			expect(got).toEqual(want);
		});
	}
});
