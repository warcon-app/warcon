// A game action the panel itself fails on (not the game's answer, not the panel's own refusal):
// the caller and the audit trail get a fixed phrase, never the error's message, which for a failed
// query lists its parameters.
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Env } from '$lib/server/env';
import { auditLog } from '$lib/server/db/schema';
import { gateway, setGateway } from '$lib/server/gateway';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

const PLAYER = '76561198000000811';
const NOTE = 'Fixture note text';

describe.skipIf(!hasTestDb)('a game action the panel fails on', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
	});

	test('answers and audits a fixed phrase', async () => {
		stubGateway();
		setGateway({
			...gateway(),
			run: async () => {
				throw new DrizzleQueryError(
					'update "players" set "note" = $1 where "steam_id" = $2',
					[NOTE, PLAYER],
					new Error('could not serialize access due to concurrent update')
				);
			}
		});
		const { POST } = await import('../routes/api/servers/[id]/rcon/[action]/+server');
		const quiet = console.error;
		console.error = () => {};
		let answer;
		try {
			answer = await callApi(POST, w.users.owner, {
				method: 'POST',
				params: { id: w.server.id, action: 'broadcast' },
				body: { message: 'Fixture broadcast' }
			});
		} finally {
			console.error = quiet;
		}
		expect([answer.status, answer.message]).toEqual([500, 'Internal error.']);
		const [row] = await env.db
			.select({ message: auditLog.message, outcome: auditLog.outcome })
			.from(auditLog)
			.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.action, 'rcon.broadcast')));
		expect(row.message).not.toContain(PLAYER);
		expect(row.message).not.toContain(NOTE);
		expect([row.outcome, row.message]).toEqual(['error', 'Internal error.']);
	});
});
