// The game's welcome popup (Season 3) as each of the cast meets it. The popup has no route, action
// or load of its own: its text and switches are the config document's, read through `config` and
// written through `configApply`, and its limits ride on the status as the game sent it. All three
// are for those who hold Config & settings. Here the real route runs the real actions against the
// demo game, and the answers are read: who gets the text, who gets the limits, what a refused line
// comes back as, and that an edit made on the document as the panel hands it out keeps the RCON
// password.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { ACTIONS, readConfig } from '$lib/server/actions';
import { gateway, setGateway } from '$lib/server/gateway';
import { WardogsClient } from '$lib/server/rcon';
import { getScalar, parseIni, SECRET_PLACEHOLDER, setScalarInText } from '$lib/config-doc';
import { welcomeLinesFromText, welcomeLinesIntoText } from '$lib/welcome-doc';
import { WELCOME_LIMITS, welcomeLimitsOf } from '$lib/welcome-text';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { expected } from './policy';
import { PRINCIPALS, seedWorld, type PrincipalName, type World } from './world';

const ROUTE = join(import.meta.dir, '../routes/api/servers/[id]/rcon/[action]/+server.ts');
const RCON = '/Script/WDRCON.WDRCONSettings';
const SEEDED = [
	'<Header>Welcome to the demo server</>',
	'Be kind, play the objective and have fun.',
	'',
	'<text color="#7FD6FF">https://warcon.example</>'
];

describe.skipIf(!hasTestDb)('the welcome popup', () => {
	let env: Env;
	let w: World;
	/** every request that reached the game, as the action that made it */
	const reached: string[] = [];
	const game = (serverId: string) =>
		new WardogsClient(
			env,
			{ id: serverId, host: 'demo', port: 1, scheme: 'http' },
			'demo',
			`welcome-popup-${serverId}`
		);

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
		// The worker's part, done here: the action as it is written, against the demo game.
		setGateway({
			...gateway(),
			run: async (_env, server, action, params) => {
				reached.push(action);
				return ACTIONS[action].run(game(server.id), params);
			}
		});
		// A file with an RCON password in it, as every real one has.
		const client = game(w.server.id);
		const doc = await readConfig(client);
		const put = await client.configCall(
			'PUT',
			'/v1/config',
			setScalarInText(doc.text, RCON, 'Password', 'hunter2'),
			doc.revision
		);
		expect(put.status).toBe(200);
	});

	const ask = async (who: PrincipalName, action: string, method: 'GET' | 'POST', input: object) => {
		const handler = (await import(ROUTE))[method];
		return callApi(handler, w.users[who], {
			method,
			params: { id: w.server.id, action },
			...(method === 'GET'
				? { query: new URLSearchParams(input as Record<string, string>).toString() }
				: { body: input })
		});
	};
	const result = <T>(answer: { body: unknown }) => (answer.body as { result: T }).result;

	test('its text is read with the config document: Config & settings, and nobody else', async () => {
		const got: Record<string, unknown> = {};
		const want: Record<string, unknown> = {};
		for (const who of PRINCIPALS) {
			const answer = await ask(who, 'config', 'GET', {});
			const verdict = expected('cap:config.apply', who);
			want[who] = verdict === 'ok' ? SEEDED : verdict;
			got[who] =
				answer.status === 200
					? welcomeLinesFromText(result<{ text: string }>(answer).text)
					: answer.status;
			// a refusal says nothing of the popup, and the password is in no answer at all
			if (answer.status !== 200) expect(JSON.stringify(answer.body)).not.toContain('Welcome');
			expect(JSON.stringify(answer.body)).not.toContain('hunter2');
		}
		expect(got).toEqual(want);
		// only those let through caused a read of the game
		expect(reached).toEqual(
			PRINCIPALS.filter((who) => expected('cap:config.apply', who) === 'ok').map(() => 'config')
		);
	});

	test('its limits ride on the status as the game sent it, which only Config & settings gets', async () => {
		const got: Record<string, unknown> = {};
		const want: Record<string, unknown> = {};
		for (const who of PRINCIPALS) {
			const answer = await ask(who, 'status', 'GET', { raw: '1' });
			const view = expected('cap:server.view', who);
			const config = expected('cap:config.apply', who) === 'ok';
			want[who] = view !== 'ok' ? view : config ? WELCOME_LIMITS : 'no limits';
			if (answer.status !== 200) {
				got[who] = answer.status;
				continue;
			}
			const status = result<{ raw?: { welcomeMessage?: unknown } }>(answer);
			got[who] = status.raw ? welcomeLimitsOf(status.raw.welcomeMessage) : 'no limits';
			// a viewer's status carries nothing of the popup under any name
			if (!config) expect(JSON.stringify(status)).not.toMatch(/welcome|maxLineLength/i);
		}
		expect(got).toEqual(want);
	});

	test('a line the game refuses comes back with the line named, and nothing is written', async () => {
		const before = result<{ text: string; revision: string }>(
			await ask('admin', 'config', 'GET', {})
		);
		const text = welcomeLinesIntoText(before.text, [
			...SEEDED,
			'x'.repeat(129),
			'<a href="https://x.example">rules</>'
		]);
		const named = [
			'Line 5 has 129 visible characters, and the popup takes 128.',
			'Line 6: <a> is not a tag the popup takes; only <text> has attributes.'
		];

		const checked = await ask('admin', 'configValidate', 'POST', { text });
		expect(checked.status).toBe(200);
		const verdict = result<{ ok: boolean; errorCode: string; errors: { message: string }[] }>(
			checked
		);
		expect([verdict.ok, verdict.errorCode]).toEqual([false, 'config_invalid']);
		expect(verdict.errors.map((e) => e.message)).toEqual(named);

		const applied = await ask('admin', 'configApply', 'POST', { text, revision: before.revision });
		expect([applied.status, applied.code]).toEqual([400, 'config_invalid']);
		const body = (applied.body as { error: { body: { errors: { message: string }[] } } }).error
			.body;
		expect(body.errors.map((e) => e.message)).toEqual(named);
		expect(JSON.stringify(applied.body)).not.toContain('hunter2');

		const after = result<{ text: string; revision: string }>(
			await ask('admin', 'config', 'GET', {})
		);
		expect(after).toEqual(before);
	});

	test('whoever may not apply the config changes nothing, and the game never hears of it', async () => {
		const text = welcomeLinesIntoText(
			result<{ text: string }>(await ask('owner', 'config', 'GET', {})).text,
			['<Bold>taken over</>']
		);
		reached.length = 0;
		for (const who of PRINCIPALS) {
			const verdict = expected('cap:config.apply', who);
			if (verdict === 'ok') continue;
			for (const action of ['configApply', 'configValidate'])
				expect([
					who,
					action,
					(await ask(who, action, 'POST', { text, force: true })).status
				]).toEqual([who, action, verdict]);
		}
		expect(reached).toEqual([]);
		expect(welcomeLinesFromText((await readConfig(game(w.server.id))).text)).toEqual(SEEDED);
	});

	test('an edit of the popup on the document as handed out keeps the RCON password', async () => {
		const shown = result<{ text: string; revision: string }>(
			await ask('admin', 'config', 'GET', {})
		);
		expect(getScalar(parseIni(shown.text), RCON, 'Password')).toBe(SECRET_PLACEHOLDER);
		const lines = [
			'<text size="20" fontface="Bold" color="#FF4D4D">SERVER RULES</>',
			'',
			'Keep chat in <text color="#7FD6FF">English</> | be respectful',
			'"No cheating" means none: https://dogpile.example/rules',
			'Welcome {player}'
		];
		const applied = await ask('admin', 'configApply', 'POST', {
			text: welcomeLinesIntoText(shown.text, lines),
			revision: shown.revision
		});
		expect(applied.status).toBe(200);
		expect(JSON.stringify(applied.body)).not.toContain('hunter2');

		// the file as the game holds it: the new text, and the password as it was
		const held = await readConfig(game(w.server.id));
		expect(welcomeLinesFromText(held.text)).toEqual(lines);
		expect(getScalar(parseIni(held.text), RCON, 'Password')).toBe('hunter2');
		expect(held.text).not.toContain(SECRET_PLACEHOLDER);
		// and as the next reader is shown it
		const next = result<{ text: string }>(await ask('owner', 'config', 'GET', {}));
		expect(welcomeLinesFromText(next.text)).toEqual(lines);
		expect(next.text).not.toContain('hunter2');
	});
});
