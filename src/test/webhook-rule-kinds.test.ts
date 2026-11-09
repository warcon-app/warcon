// The kinds of rule a Discord webhook ticked for Automation carries: who may choose them (an owner
// of the org, never a key), what a choice must hold, the audit row, and what reaches each channel.
// A webhook that names no kinds carries every rule, as before; one that names some carries only
// theirs, and what it takes from the other event classes does not change.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, webhooks } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import { resetWebhookQueues } from '$lib/server/webhook-delivery';
import type { WebhookView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';
import { GET as listRoute, POST as createRoute } from '../routes/api/orgs/[id]/webhooks/+server';
import { PATCH as editRoute } from '../routes/api/orgs/[id]/webhooks/[webhookId]/+server';

const TOKEN = 'a'.repeat(68);
const urlOf = (id: string) => `https://discord.com/api/webhooks/${id}/${TOKEN}`;

describe.skipIf(!hasTestDb)('the kinds of rule a Discord webhook carries', () => {
	let env: Env;
	let w: World;
	/** every post, with the webhook it went to */
	const posts: { url: string; titles: string[] }[] = [];
	const realFetch = globalThis.fetch;
	let every: WebhookView;
	let some: WebhookView;

	const create = (body: Record<string, unknown>) =>
		callApi(createRoute, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			body
		});
	const edit = (who: PrincipalName, triggerKinds: unknown, id = some.id, orgId = w.org.id) =>
		callApi(editRoute, w.users[who], {
			method: 'PATCH',
			params: { id: orgId, webhookId: id },
			body: { triggerKinds }
		});
	const stored = async (id = some.id) =>
		(
			await env.db
				.select({ kinds: webhooks.triggerKinds })
				.from(webhooks)
				.where(eq(webhooks.id, id))
		)[0].kinds;
	const delivery = (kind: string, outcome: 'ok' | 'error' = 'ok') =>
		writeAudit(env, null, {
			actorName: `trigger: ${kind}`,
			server: { id: w.server.id, name: 'Server' },
			orgId: w.org.id,
			category: 'trigger',
			action: `trigger.${kind}`,
			target: '76561198000000961',
			outcome,
			message: 'Done.'
		});
	/** what each webhook was sent since the last call */
	const sent = async () => {
		await new Promise((r) => setTimeout(r, 2000));
		const to = (hook: WebhookView) =>
			posts
				.filter((p) => p.url.startsWith(urlOf(hook.urlHint.split('/')[3])))
				.flatMap((p) => p.titles);
		const answer = { every: to(every), some: to(some) };
		posts.length = 0;
		return answer;
	};

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? '{}')) as { embeds?: { title: string }[] };
			posts.push({ url: String(url), titles: (body.embeds ?? []).map((e) => e.title) });
			return new Response('{"id":"1"}', { status: 200 });
		}) as typeof fetch;
		const a = await create({ url: urlOf('100000000000000001'), events: ['triggers'] });
		expect(a.status).toBe(201);
		every = (a.body as { webhook: WebhookView }).webhook;
		const b = await create({
			url: urlOf('100000000000000002'),
			events: ['triggers', 'commands'],
			triggerKinds: ['kill_distance', 'team_kill']
		});
		expect(b.status).toBe(201);
		some = (b.body as { webhook: WebhookView }).webhook;
	});

	afterAll(() => {
		globalThis.fetch = realFetch;
		resetWebhookQueues();
	});

	test('a new webhook carries every kind unless it names some, kept in the order of the kinds', async () => {
		expect(every.triggerKinds).toBeNull();
		expect(await stored(every.id)).toBeNull();
		expect(some.triggerKinds).toEqual(['team_kill', 'kill_distance']);
		const list = await callApi(listRoute, w.users.owner, { params: { id: w.org.id } });
		const shown = (list.body as { webhooks: WebhookView[] }).webhooks;
		expect(shown.find((h) => h.id === some.id)?.triggerKinds).toEqual([
			'team_kill',
			'kill_distance'
		]);
	});

	test('each channel hears of the rules it carries, and nothing else changes', async () => {
		await delivery('welcome');
		await delivery('team_kill');
		await delivery('kill_distance');
		await delivery('name_filter', 'error');
		await writeAudit(env, null, {
			actorName: 'admin',
			server: { id: w.server.id, name: 'Server' },
			orgId: w.org.id,
			category: 'rcon',
			action: 'rcon.kick',
			target: '76561198000000962',
			outcome: 'ok',
			message: 'Kicked.'
		});
		expect(await sent()).toEqual({
			every: [
				'Trigger · welcome whisper',
				'Trigger · team kill limit',
				'Trigger · kill distance watch',
				'Trigger · name filter'
			],
			some: ['Trigger · team kill limit', 'Trigger · kill distance watch', 'Kick']
		});
	});

	test('only an owner of the org chooses them, and never through a key', async () => {
		for (const who of [
			'anon',
			'stranger',
			'outsider',
			'member',
			'viewer',
			'operator',
			'admin',
			'elsewhere',
			'orgBans',
			'orgSlots',
			'keyView',
			'keyAll',
			'keyElsewhere',
			'keyBans'
		] as PrincipalName[]) {
			const answer = await edit(who, ['welcome']);
			expect({ who, refused: answer.status >= 400 }).toEqual({ who, refused: true });
			expect(await stored()).toEqual(['team_kill', 'kill_distance']);
		}
		expect((await edit('anon', ['welcome'])).status).toBe(401);
		expect((await edit('keyAll', ['welcome'])).status).toBe(403);
		expect((await edit('member', ['welcome'])).status).toBe(403);
		expect((await edit('outsider', ['welcome'])).status).toBe(404);
		// an owner of another org cannot reach this webhook through their own org
		expect((await edit('outsider', ['welcome'], some.id, w.otherOrg.id)).status).toBe(404);
		expect(await stored()).toEqual(['team_kill', 'kill_distance']);

		const done = await edit('owner', ['name_filter', 'team_kill']);
		expect(done.status).toBe(200);
		expect((done.body as { webhook: WebhookView }).webhook.triggerKinds).toEqual([
			'team_kill',
			'name_filter'
		]);
		expect(await stored()).toEqual(['team_kill', 'name_filter']);
		expect((await sent()).some).toEqual([]);
	});

	test('the change is in the audit trail with the kinds it chose', async () => {
		const [row] = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'org.webhook.update')))
			.orderBy(desc(auditLog.id))
			.limit(1);
		expect(row.actorId).toBe(w.users.owner!.id);
		expect((row.detail as { triggerKinds: unknown }).triggerKinds).toEqual([
			'team_kill',
			'name_filter'
		]);
	});

	test('an empty, unknown or malformed choice is refused, never read as every kind', async () => {
		for (const bad of [[], ['nope'], ['team_kill', 'nope'], 'team_kill', 7, {}, [null]]) {
			const answer = await edit('owner', bad);
			expect({ bad, status: answer.status, code: answer.code }).toEqual({
				bad,
				status: 400,
				code: 'bad_kinds'
			});
		}
		expect(await stored()).toEqual(['team_kill', 'name_filter']);
		const made = await create({
			url: urlOf('100000000000000003'),
			events: ['triggers'],
			triggerKinds: []
		});
		expect(made.status).toBe(400);
	});

	test('null puts every kind back', async () => {
		expect((await edit('owner', null)).status).toBe(200);
		expect(await stored()).toBeNull();
		await delivery('welcome');
		expect((await sent()).some).toEqual(['Trigger · welcome whisper']);
	});
});
