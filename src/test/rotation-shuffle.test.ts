// A Rotation shuffle rule shuffles once more when its settings are saved or it is switched on again:
// both start it over (no state), so the worker's next look shuffles. A rename or a switch-off keeps
// where it stands, as does switching on a rule that was on.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { triggers } from '$lib/server/db/schema';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');

describe.skipIf(!hasTestDb)('Rotation shuffle rule state', () => {
	let env: Env;
	let w: World;
	const route = async (method: string, path: string) =>
		(await import(join(ROUTES, path, '+server.ts')))[method];
	const STATE = { boot: 1_791_500_000_000, forNext: true, spentBy: 0 };

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
	});

	test('saving the settings, or switching it on again, starts it over', async () => {
		const made = await callApi(await route('POST', 'api/servers/[id]/triggers'), w.users.owner, {
			method: 'POST',
			params: { id: w.server.id },
			body: { kind: 'rotation_shuffle', name: 'Shuffle', enabled: true, config: { maps: [] } }
		});
		expect(made.status).toBe(201);
		const id = (made.body as { trigger: { id: string } }).trigger.id;
		const patch = await route('PATCH', 'api/servers/[id]/triggers/[triggerId]');
		const save = (body: Record<string, unknown>) =>
			callApi(patch, w.users.owner, {
				method: 'PATCH',
				params: { id: w.server.id, triggerId: id },
				body
			});
		const state = async () =>
			(await env.db.select({ state: triggers.state }).from(triggers).where(eq(triggers.id, id)))[0]
				.state;
		const shuffled = () => env.db.update(triggers).set({ state: STATE }).where(eq(triggers.id, id));

		await shuffled();
		expect((await save({ name: 'Daily shuffle' })).status).toBe(200);
		expect(await state()).toEqual(STATE);
		expect((await save({ enabled: true })).status).toBe(200);
		expect(await state()).toEqual(STATE);
		expect((await save({ config: { maps: ['Europe', 'Kavkazi'] } })).status).toBe(200);
		expect(await state()).toBeNull();

		await shuffled();
		expect((await save({ enabled: false })).status).toBe(200);
		expect(await state()).toEqual(STATE);
		expect((await save({ enabled: true })).status).toBe(200);
		expect(await state()).toBeNull();
		// The editor sends everything at once: a save of a rule that is on starts it over too.
		await shuffled();
		expect(
			(await save({ name: 'Daily shuffle', enabled: true, config: { maps: ['Kavkazi'] } })).status
		).toBe(200);
		expect(await state()).toBeNull();
	});
});
