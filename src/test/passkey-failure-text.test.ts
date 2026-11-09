// A passkey sign-in that fails for a reason other than Better Auth's refusal (a failed query, whose
// message lists its parameters) leaves a fixed phrase in the audit trail.
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { RequestEvent } from '@sveltejs/kit';
import type { Env } from '$lib/server/env';
import { auditLog } from '$lib/server/db/schema';
import { hasTestDb, testEnv } from './db';
import { callApi } from './call';

const CREDENTIAL = 'fixture-credential-id';
const USER = 'u_fixture_passkey';

describe.skipIf(!hasTestDb)('a passkey sign-in the panel fails on', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	test('audits a fixed phrase', async () => {
		const { POST } = await import('../routes/api/passkeys/auth/+server');
		const auth = {
			api: {
				verifyPasskeyAuthentication: async () => {
					throw new DrizzleQueryError(
						'update "passkey" set "counter" = $1 where "id" = $2 and "user_id" = $3',
						[7, CREDENTIAL, USER],
						new Error('connection terminated unexpectedly')
					);
				}
			}
		};
		const handler = (event: RequestEvent) =>
			POST({ ...event, locals: { ...event.locals, auth } } as never);
		const quiet = console.error;
		console.error = () => {};
		let answer;
		try {
			answer = await callApi(handler, null, { method: 'POST', body: { response: { id: 'x' } } });
		} finally {
			console.error = quiet;
		}
		expect(answer.code).toBe('passkey_rejected');
		const rows = await env.db
			.select({ message: auditLog.message })
			.from(auditLog)
			.where(and(eq(auditLog.action, 'login'), eq(auditLog.target, 'passkey')));
		expect(rows.length).toBe(1);
		expect(rows[0].message).not.toContain(CREDENTIAL);
		expect(rows[0].message).not.toContain(USER);
		expect(rows[0].message).toBe('Passkey rejected');
	});
});
