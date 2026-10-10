// Every page load under (app), asked by everyone who can hold a session (API keys are only read
// on /api, so they never reach a load). A layout's check protects nothing below it, which is why
// each page is asked on its own here, with no parent data: see page-loads.test.ts for the rule.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Env } from '$lib/server/env';
import { hasTestDb, testEnv } from './db';
import { callLoad, stubGateway } from './call';
import { expected, outcomeOf, type Policy } from './policy';
import { PRINCIPALS, seedWorld, type World } from './world';

const APP = join(import.meta.dir, '..', 'routes', '(app)');

/**
 * Loads that decide from the (app) layout's data (`await parent()`, which SvelteKit does run for
 * a masked request) or send the visitor elsewhere; they read nothing of their own to guard.
 */
const FROM_PARENT = [
	'+layout.server.ts',
	'orgs/+page.server.ts',
	'servers/+page.server.ts',
	'settings/+page.server.ts',
	'users/+page.server.ts',
	'server/[id]/discord/+page.server.ts',
	'server/[id]/public/+page.server.ts'
];

const MATRIX: Record<string, Policy> = {
	'account/+page.server.ts': 'user',
	'audit/+page.server.ts': 'user',
	'admin/+layout.server.ts': 'site',
	'admin/+page.server.ts': 'site',
	'admin/settings/+page.server.ts': 'site',
	'admin/users/+page.server.ts': 'site',
	'orgs/[id]/+layout.server.ts': 'lists',
	'orgs/[id]/+page.server.ts': 'orgOwner',
	'orgs/[id]/access/+page.server.ts': 'orgOwner',
	'orgs/[id]/roles/+page.server.ts': 'orgOwner',
	'orgs/[id]/seasons/+page.server.ts': 'orgOwner',
	'orgs/[id]/bans/+page.server.ts': 'lists:ban',
	'orgs/[id]/reserved/+page.server.ts': 'lists:reserve',
	// "Group not found." is not a hidden answer: a group looked up before the role check fails it
	'orgs/[id]/reserved/[groupId]/+page.server.ts': 'lists:reserve',
	'orgs/[id]/players/+page.server.ts': 'lists',
	'server/[id]/+layout.server.ts': 'cap:server.view',
	'server/[id]/automation/+page.server.ts': 'cap:automation.manage',
	'server/[id]/config/+page.server.ts': 'cap:server.view',
	'server/[id]/bans/+page.server.ts': 'cap:server.view',
	'server/[id]/slots/+page.server.ts': 'cap:server.view',
	'server/[id]/settings/+page.server.ts': 'cap:server.view',
	'server/[id]/matches/[matchId]/+page.server.ts': 'cap:server.view',
	'server/[id]/players/[steamId]/+page.server.ts': 'cap:server.view'
};

const SESSIONS = PRINCIPALS.filter((who) => !who.startsWith('key'));

const loads = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? loads(join(dir, e.name))
			: /^\+(page|layout)\.server\.ts$/.test(e.name)
				? [relative(APP, join(dir, e.name))]
				: []
	);

test('every load under (app) has a line in the matrix', () => {
	expect([...Object.keys(MATRIX), ...FROM_PARENT].sort()).toEqual(loads(APP).sort());
});

test('the loads left to their parent read nothing from the server themselves', () => {
	for (const file of FROM_PARENT.slice(1)) {
		const source = readFileSync(join(APP, file), 'utf8');
		expect({
			file,
			guarded: !/getEnv\(\)/.test(source) || /await parent\(\)/.test(source)
		}).toEqual({ file, guarded: true });
	}
});

describe.skipIf(!hasTestDb)('page load permission matrix', () => {
	let env: Env;
	let world: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		world = await seedWorld(env);
	});

	for (const [file, policy] of Object.entries(MATRIX)) {
		test(`${file} is ${policy}`, async () => {
			const { load } = await import(join(APP, file));
			const id = file.startsWith('orgs/') ? world.org.id : world.server.id;
			const got: Record<string, unknown> = {};
			const want: Record<string, unknown> = {};
			for (const who of SESSIONS) {
				want[who] = expected(policy, who);
				// The admin pages answer 403 to everyone but the site owner, signed in or not.
				if (policy === 'site' && who === 'anon') want[who] = 403;
				const answer = await callLoad(load, world.users[who], {
					params: { id, steamId: '76561198000000001' }
				});
				got[who] = outcomeOf(answer);
			}
			expect(got).toEqual(want);
		});
	}
});
