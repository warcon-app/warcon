// The roles a Discord webhook pings for a Staff call: who may give them (an owner of the org, never
// a key), what counts as a role, what the message to Discord then holds (those roles' mentions,
// and leave to ping those roles alone), how often, and that nothing a player types, and no other
// card, pings anyone. Discord here is a stand-in that keeps what it was sent.
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, webhooks } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import {
	editDiscord,
	notifyStaffCall,
	notifyTeamKills,
	PING_REFUSED,
	postDiscord,
	resetWebhookQueues,
	STAFF_PING_MS,
	type StaffCallCard
} from '$lib/server/webhook-delivery';
import { STAFF_PING_MINUTES } from '$lib/discord-role';
import type { KillView, WebhookView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';
import { GET as listRoute, POST as createRoute } from '../routes/api/orgs/[id]/webhooks/+server';
import { PATCH as editRoute } from '../routes/api/orgs/[id]/webhooks/[webhookId]/+server';
import { POST as testRoute } from '../routes/api/orgs/[id]/webhooks/[webhookId]/test/+server';
import { load as orgLoad } from '../routes/(app)/orgs/[id]/+page.server';
import { load as settingsLoad } from '../routes/(app)/server/[id]/settings/+page.server';

const TOKEN = 'a'.repeat(68);
const urlOf = (id: string) => `https://discord.com/api/webhooks/${id}/${TOKEN}`;
const STAFF = '111111111111111111';
const MODS = '222222222222222222';
const SENIOR = '333333333333333333';
/** a role of the same Discord server that no webhook was given */
const BIG = '999999999999999999';
const CALLER = '76561198000000971';
/** long enough for the queue to send what it holds (it waits 1.5 s for more), on a busy machine too */
const FLUSHED = 2500;
const SERVER = join(import.meta.dir, '..', 'lib', 'server');

interface Post {
	hook: string;
	content: string | undefined;
	mentions: unknown;
	titles: string[];
	text: string;
	raw: string;
}

describe.skipIf(!hasTestDb)('the roles a webhook pings for a Staff call', () => {
	let env: Env;
	let w: World;
	const posts: Post[] = [];
	/** what the stand-in answers the next posts to a webhook with, by the webhook's Discord id */
	const answers = new Map<string, Response[]>();
	const realFetch = globalThis.fetch;
	/** takes Staff calls, game commands and team kills, and gets a role in the tests below */
	let staff: WebhookView;
	/** takes Staff calls, with no role */
	let plain: WebhookView;
	/** takes Staff calls with two roles of its own */
	let mods: WebhookView;
	/** has a role and no Staff calls box */
	let unticked: WebhookView;

	const create = (body: Record<string, unknown>) =>
		callApi(createRoute, w.users.owner, { method: 'POST', params: { id: w.org.id }, body });
	const edit = (who: PrincipalName, staffRoleIds: unknown, id = staff.id, orgId = w.org.id) =>
		callApi(editRoute, w.users[who], {
			method: 'PATCH',
			params: { id: orgId, webhookId: id },
			body: { staffRoleIds }
		});
	const stored = async (id = staff.id) =>
		(
			await env.db.select({ role: webhooks.staffRoleIds }).from(webhooks).where(eq(webhooks.id, id))
		)[0].role;
	const discordId = (hook: WebhookView) => hook.urlHint.split('/')[3];
	const card = (over: Partial<StaffCallCard> = {}): StaffCallCard => ({
		at: new Date().toISOString(),
		word: 'admin',
		report: false,
		text: 'he is stuck under the map at B',
		channel: 'All',
		caller: { steamId: CALLER, name: 'Night Owl', hiddenName: '', anonymous: false },
		about: null,
		map: 'Kavkazi',
		players: 40,
		...over
	});
	const call = (over: Partial<StaffCallCard> = {}) =>
		notifyStaffCall(env, { id: w.server.id, orgId: w.org.id, name: 'Server' }, card(over));
	/** what each webhook was sent since the last look, oldest first */
	const sent = async () => {
		await new Promise((r) => setTimeout(r, FLUSHED));
		const to = (hook: WebhookView) => posts.filter((p) => p.hook === discordId(hook));
		const answer = { staff: to(staff), plain: to(plain), mods: to(mods), unticked: to(unticked) };
		posts.length = 0;
		return answer;
	};
	// the roles' mentions, then the panel's own words for a notification that shows no card
	const PING = (...roles: string[]) => ({
		content: `${roles.map((role) => `<@&${role}>`).join(' ')} A player is calling staff.`,
		mentions: { parse: [], roles }
	});
	const QUIET = { content: undefined, mentions: { parse: [] } };
	const how = (p: Post | undefined) => p && { content: p.content, mentions: p.mentions };

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const raw = String(init?.body ?? '{}');
			const body = JSON.parse(raw) as {
				content?: string;
				allowed_mentions?: unknown;
				embeds?: { title: string; description: string }[];
			};
			const hook = /\/api\/webhooks\/(\d+)\//.exec(String(url))?.[1] ?? '';
			posts.push({
				hook,
				content: body.content,
				mentions: body.allowed_mentions,
				titles: (body.embeds ?? []).map((e) => e.title),
				text: (body.embeds ?? []).map((e) => e.description).join('\n'),
				raw
			});
			return answers.get(hook)?.shift() ?? new Response('{"id":"1"}', { status: 200 });
		}) as typeof fetch;
		const made = async (id: string, body: Record<string, unknown>) => {
			const answer = await create({ url: urlOf(id), ...body });
			expect(answer.status).toBe(201);
			return (answer.body as { webhook: WebhookView }).webhook;
		};
		staff = await made('100000000000000011', { events: ['staffcalls', 'commands', 'teamkills'] });
		plain = await made('100000000000000012', { events: ['staffcalls'] });
		mods = await made('100000000000000013', {
			events: ['staffcalls'],
			staffRoleIds: [MODS, SENIOR]
		});
		unticked = await made('100000000000000014', { events: ['bans'], staffRoleIds: `<@&${MODS}>` });
	});

	afterEach(() => {
		setSystemTime();
		answers.clear();
		posts.length = 0;
		resetWebhookQueues();
	});

	afterAll(() => {
		globalThis.fetch = realFetch;
		resetWebhookQueues();
	});

	test('a webhook pings no role until it is given some, as numbers or as Discord writes the mention', async () => {
		expect(staff.staffRoleIds).toEqual([]);
		expect(await stored()).toBeNull();
		expect(mods.staffRoleIds).toEqual([MODS, SENIOR]);
		expect(await stored(mods.id)).toEqual([MODS, SENIOR]);
		expect(unticked.staffRoleIds).toEqual([MODS]);
		expect(await stored(unticked.id)).toEqual([MODS]);
		const list = await callApi(listRoute, w.users.owner, { params: { id: w.org.id } });
		const shown = (list.body as { webhooks: WebhookView[] }).webhooks;
		expect(shown.map((h) => h.staffRoleIds)).toEqual([[], [], [MODS, SENIOR], [MODS]]);
	});

	test('only an owner of the org gives it, and never through a key', async () => {
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
			const answer = await edit(who, [STAFF]);
			expect({ who, refused: answer.status >= 400 }).toEqual({ who, refused: true });
			expect(await stored()).toBeNull();
		}
		expect((await edit('anon', [STAFF])).status).toBe(401);
		expect((await edit('keyAll', [STAFF])).status).toBe(403);
		expect((await edit('admin', [STAFF])).status).toBe(403);
		expect((await edit('outsider', [STAFF])).status).toBe(404);
		// an owner of another org cannot reach this webhook through their own org
		expect((await edit('outsider', [STAFF], staff.id, w.otherOrg.id)).status).toBe(404);
		expect(await stored()).toBeNull();
		// nor does any of them see it: the list is the owners'
		for (const who of ['anon', 'outsider', 'member', 'admin', 'keyAll'] as PrincipalName[]) {
			const list = await callApi(listRoute, w.users[who], { params: { id: w.org.id } });
			expect({ who, refused: list.status >= 400 }).toEqual({ who, refused: true });
		}

		const done = await edit('owner', ` <@&${STAFF}> `);
		expect(done.status).toBe(200);
		expect((done.body as { webhook: WebhookView }).webhook.staffRoleIds).toEqual([STAFF]);
		expect(await stored()).toEqual([STAFF]);
	});

	test('the pages that list webhooks show the roles to an owner of the org and to nobody else', async () => {
		const rolesIn = (body: unknown, key: 'webhooks' | 'channels') =>
			((body as Record<string, WebhookView[]>)[key] ?? []).map((h) => h.staffRoleIds);
		// the organisation page: owners only
		const page = await callLoad(orgLoad, w.users.owner, { params: { id: w.org.id } });
		expect(rolesIn(page.body, 'webhooks')).toEqual([[STAFF], [], [MODS, SENIOR], [MODS]]);
		for (const who of [
			'anon',
			'stranger',
			'outsider',
			'member',
			'viewer',
			'operator',
			'admin',
			'elsewhere'
		] as PrincipalName[]) {
			const refused = await callLoad(orgLoad, w.users[who], { params: { id: w.org.id } });
			expect({ who, refused: refused.status >= 300 }).toEqual({ who, refused: true });
			expect(JSON.stringify(refused.body ?? null)).not.toContain(STAFF);
		}
		// the server's Settings tab lists the channels that carry its team kills: the same owners
		const tab = await callLoad(settingsLoad, w.users.owner, { params: { id: w.server.id } });
		expect(rolesIn(tab.body, 'channels')).toEqual([[STAFF]]);
		for (const who of ['viewer', 'operator', 'admin'] as PrincipalName[]) {
			const seen = await callLoad(settingsLoad, w.users[who], { params: { id: w.server.id } });
			expect({ who, status: seen.status, channels: rolesIn(seen.body, 'channels') }).toEqual({
				who,
				status: 200,
				channels: []
			});
			expect(JSON.stringify(seen.body)).not.toContain(STAFF);
		}
		for (const who of ['anon', 'stranger', 'outsider'] as PrincipalName[]) {
			const refused = await callLoad(settingsLoad, w.users[who], { params: { id: w.server.id } });
			expect({ who, refused: refused.status >= 300 }).toEqual({ who, refused: true });
			expect(JSON.stringify(refused.body ?? null)).not.toContain(STAFF);
		}
	});

	test('the change is in the audit trail with the roles it chose', async () => {
		const [row] = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'org.webhook.update')))
			.orderBy(desc(auditLog.id))
			.limit(1);
		expect(row.actorId).toBe(w.users.owner!.id);
		expect((row.detail as { staffRoleIds: unknown }).staffRoleIds).toEqual([STAFF]);
	});

	test('what is not a list of roles is refused whole, never kept in part or as something else', async () => {
		const six = ['1', '2', '3', '4', '5', '6'].map((n) => `44444444444444444${n}`);
		for (const bad of [
			'Staff',
			'@everyone',
			'@here',
			`<@${STAFF}>`,
			`<@&${STAFF}> @everyone`,
			`${STAFF} everyone`,
			'1234',
			// past the largest number an ID can be: Discord would refuse the whole message for it
			'9223372036854775808',
			'12345678901234567890',
			Number(STAFF),
			{ id: STAFF },
			true,
			[STAFF, 'everyone'],
			[STAFF, Number(MODS)],
			[[STAFF]],
			// more than a webhook may ping, as a list and as text
			six,
			six.join(' ')
		]) {
			const answer = await edit('owner', bad);
			expect({ bad, status: answer.status, code: answer.code }).toEqual({
				bad,
				status: 400,
				code: 'bad_role'
			});
		}
		expect(await stored()).toEqual([STAFF]);
		const made = await create({
			url: urlOf('100000000000000015'),
			events: ['staffcalls'],
			staffRoleIds: [STAFF, '@everyone']
		});
		expect(made.status).toBe(400);
		// several, as a list or in one text, each once and in the order given; five is the most
		expect((await edit('owner', `${MODS}, <@&${STAFF}>\n${MODS}`)).status).toBe(200);
		expect(await stored()).toEqual([MODS, STAFF]);
		const five = await edit('owner', [STAFF, ...six.slice(0, 4), STAFF]);
		expect((five.body as { webhook: WebhookView }).webhook.staffRoleIds).toEqual([
			STAFF,
			...six.slice(0, 4)
		]);
		// null, '' and an empty list all say no ping, and a change that does not name the roles
		// leaves them alone
		for (const none of [null, '', []]) {
			expect((await edit('owner', [STAFF])).status).toBe(200);
			expect((await edit('owner', none)).status).toBe(200);
			expect(await stored()).toBeNull();
		}
		expect((await edit('owner', [STAFF])).status).toBe(200);
		const other = await callApi(editRoute, w.users.owner, {
			method: 'PATCH',
			params: { id: w.org.id, webhookId: staff.id },
			body: { label: 'Staff room' }
		});
		expect(other.status).toBe(200);
		expect(await stored()).toEqual([STAFF]);
	});

	test('a call pings each webhook’s own roles and nothing else, whatever the player wrote', async () => {
		expect(
			await call({
				text: `@everyone @here <@&${BIG}> <@${STAFF}> help`,
				caller: {
					steamId: CALLER,
					name: `@everyone <@&${BIG}>`,
					hiddenName: '',
					anonymous: false
				}
			})
		).toBe(3);
		const got = await sent();
		expect(got.staff.map((p) => p.titles)).toEqual([['Staff call · !admin']]);
		// the message opens with the role's mention and the panel's own words, and no other text;
		// a webhook with two roles names both, and Discord is allowed those two
		expect(how(got.staff[0])).toEqual(PING(STAFF));
		expect(how(got.mods[0])).toEqual(PING(MODS, SENIOR));
		// a channel with no role is sent the card as before
		expect(how(got.plain[0])).toEqual(QUIET);
		expect(got.plain[0].raw).not.toContain('"content"');
		// a webhook without the Staff calls box carries no call, role or not
		expect(got.unticked).toEqual([]);
		// what the player wrote is in the card, where Discord pings nobody, and in nothing that
		// Discord is allowed to act on
		expect(got.staff[0].text).toContain('help');
		for (const p of [...got.staff, ...got.mods, ...got.plain]) {
			expect(p.content ?? '').not.toContain('everyone');
			expect(p.content ?? '').not.toContain(BIG);
			expect(JSON.stringify(p.mentions)).not.toContain(BIG);
			expect(JSON.stringify(p.mentions)).not.toContain('everyone');
			expect(JSON.stringify(p.mentions)).not.toContain('users');
		}
	}, 15_000);

	test(`a channel is pinged once in ${STAFF_PING_MINUTES} minutes: calls that follow sooner arrive without`, async () => {
		// what the editor and the README say
		expect(STAFF_PING_MINUTES).toBe(5);
		expect(STAFF_PING_MS).toBe(5 * 60_000);
		await call();
		expect(how((await sent()).staff[0])).toEqual(PING(STAFF));
		// the ping went out a moment before this; the clock is moved from here
		const seen = Date.now();
		await call({ word: 'mods' });
		const second = await sent();
		expect(second.staff.map((p) => p.titles)).toEqual([['Staff call · !mods']]);
		expect(how(second.staff[0])).toEqual(QUIET);
		expect(how(second.mods[0])).toEqual(QUIET);
		// a minute short of the time: still none
		setSystemTime(new Date(seen + STAFF_PING_MS - 60_000));
		await call();
		expect(how((await sent()).staff[0])).toEqual(QUIET);
		// and once it has passed, the next call pings again
		setSystemTime(new Date(seen + STAFF_PING_MS + 1000));
		await call();
		const later = await sent();
		expect(how(later.staff[0])).toEqual(PING(STAFF));
		expect(how(later.mods[0])).toEqual(PING(MODS, SENIOR));
	}, 30_000);

	test('two calls in one message ping once, and each webhook keeps its own count', async () => {
		// one webhook has no role yet when the first message goes
		expect((await edit('owner', null, mods.id)).status).toBe(200);
		await call();
		await call({ word: 'mods' });
		const got = await sent();
		expect(got.staff.map((p) => p.titles)).toEqual([['Staff call · !admin', 'Staff call · !mods']]);
		expect(how(got.staff[0])).toEqual(PING(STAFF));
		expect(how(got.mods[0])).toEqual(QUIET);
		const seen = Date.now();
		// given its roles a minute later, it pings at its first call, inside the other's five minutes
		expect((await edit('owner', [MODS, SENIOR], mods.id)).status).toBe(200);
		setSystemTime(new Date(seen + 60_000));
		await call();
		const next = await sent();
		expect(how(next.staff[0])).toEqual(QUIET);
		expect(how(next.mods[0])).toEqual(PING(MODS, SENIOR));
		// and the first is due again by its own count, while the second is not
		setSystemTime(new Date(seen + STAFF_PING_MS + 1000));
		await call();
		const later = await sent();
		expect(how(later.staff[0])).toEqual(PING(STAFF));
		expect(how(later.mods[0])).toEqual(QUIET);
	}, 30_000);

	test('a call is never lost to its ping: a message Discord refuses for it goes again without', async () => {
		const row = async () =>
			(await env.db.select().from(webhooks).where(eq(webhooks.id, staff.id)))[0];
		answers.set(discordId(staff), [
			new Response('{"message":"Invalid Form Body"}', { status: 400 })
		]);
		await call();
		const got = await sent();
		// the same card twice: with the ping, refused, and without, taken
		expect(got.staff.map((p) => p.titles)).toEqual([
			['Staff call · !admin'],
			['Staff call · !admin']
		]);
		expect(got.staff.map(how)).toEqual([PING(STAFF), QUIET]);
		// the webhook still counts as working, and its row says what happened to the ping
		expect((await row()).lastStatus).toBe(200);
		expect((await row()).lastError).toBe(PING_REFUSED);
		// nobody was pinged, so the next call asks again; a ping Discord takes clears the note
		await call({ word: 'mods' });
		expect((await sent()).staff.map(how)).toEqual([PING(STAFF)]);
		expect((await row()).lastError).toBe('');
		// a message Discord refuses with or without the ping is lost as any card is, and says so
		resetWebhookQueues();
		answers.set(discordId(staff), [
			new Response('{"message":"no"}', { status: 400 }),
			new Response('{"message":"no"}', { status: 400 })
		]);
		await call();
		expect((await sent()).staff.map(how)).toEqual([PING(STAFF), QUIET]);
		expect((await row()).lastStatus).toBe(400);
		expect((await row()).lastError).not.toBe(PING_REFUSED);
	}, 30_000);

	test('a ping Discord did not take is not counted, and one it holds back is asked for again', async () => {
		// not taken (a fault of Discord's own): the card is lost as any card is, without a second
		// try, and the next call still pings
		answers.set(discordId(staff), [new Response('{"message":"no"}', { status: 500 })]);
		await call();
		const refused = await sent();
		expect(refused.staff.map(how)).toEqual([PING(STAFF)]);
		await call({ word: 'mods' });
		expect(how((await sent()).staff[0])).toEqual(PING(STAFF));

		// held back (429): the same message goes again, ping and all, and then counts
		resetWebhookQueues();
		answers.set(discordId(staff), [
			new Response('{"retry_after":0.05}', { status: 429, headers: { 'retry-after': '0.05' } })
		]);
		await call();
		const held = await sent();
		expect(held.staff.map(how)).toEqual([PING(STAFF), PING(STAFF)]);
		await call();
		expect(how((await sent()).staff[0])).toEqual(QUIET);
	}, 30_000);

	test('no other card pings, alone or in a message with a call', async () => {
		const kick = () =>
			writeAudit(env, null, {
				actorName: 'admin',
				server: { id: w.server.id, name: 'Server' },
				orgId: w.org.id,
				category: 'rcon',
				action: 'rcon.kick',
				target: CALLER,
				outcome: 'ok',
				message: `Kicked for @everyone <@&${STAFF}>`
			});
		await kick();
		const alone = await sent();
		expect(alone.staff.map((p) => p.titles)).toEqual([['Kick']]);
		expect(how(alone.staff[0])).toEqual(QUIET);
		// with a call in the same message, the one ping is the call's
		await kick();
		await call();
		const both = await sent();
		expect(both.staff.map((p) => p.titles)).toEqual([['Kick', 'Staff call · !admin']]);
		expect(how(both.staff[0])).toEqual(PING(STAFF));
		// and a kick after it, inside the five minutes or out of them, pings nobody
		setSystemTime(new Date(Date.now() + STAFF_PING_MS + 5000));
		await kick();
		expect(how((await sent()).staff[0])).toEqual(QUIET);
		// nor does a card that comes from the kill feed and no audit row
		const kill: KillView = {
			eventId: 'e1',
			ts: new Date().toISOString(),
			map: 'Kavkazi',
			eventTime: 60,
			killer: { steamId: CALLER, name: `@everyone <@&${STAFF}>`, faction: 'Lonestar' },
			victim: { steamId: '76561198000000972', name: 'Victim', faction: 'Lonestar' },
			cause: null,
			distanceM: 10,
			headshot: false,
			suicide: false,
			teamKill: true,
			tags: []
		};
		await notifyTeamKills(env, w.server.id, 'Server', [kill]);
		const feed = await sent();
		expect(feed.staff.map((p) => p.titles)).toEqual([['Team kill']]);
		expect(how(feed.staff[0])).toEqual(QUIET);
	}, 30_000);

	test('one place asks for a ping and one place sends one', () => {
		// Every card is queued through enqueue, and only a Staff call's is queued with roles; every
		// message is posted through postDiscord, and only the queue's own post names any.
		const delivery = readFileSync(join(SERVER, 'webhook-delivery.ts'), 'utf8');
		const queued = [...delivery.matchAll(/\benqueue\(env, hook, embed([^)]*)\)/g)].map((m) => m[1]);
		expect(queued.length).toBeGreaterThan(4);
		expect(queued.filter(Boolean)).toEqual([', rolesToPing(hook.staffRoleIds']);
		const posted = (file: string) =>
			[...readFileSync(join(SERVER, file), 'utf8').matchAll(/\bpostDiscord\(\s*env,\s*\w+,/g)]
				.length;
		const withRole = (file: string) =>
			[...readFileSync(join(SERVER, file), 'utf8').matchAll(/\},\s*[\w.]+\s*\)/g)].filter((m) =>
				/ping|role/i.test(m[0])
			).length;
		expect(delivery.match(/embeds: batch \}, ping\)/g)?.length).toBe(1);
		expect(withRole('webhook-delivery.ts')).toBe(1);
		// the test message, the test card and the status cards: posted, and none with a role
		expect(posted('webhooks.ts')).toBe(2);
		expect(withRole('webhooks.ts')).toBe(0);
		expect(posted('webhook-status.ts')).toBe(1);
		expect(readFileSync(join(SERVER, 'webhook-status.ts'), 'utf8')).toContain(
			'postDiscord(env, hook, payload)'
		);
	});

	test('nothing but a role’s own number makes a ping, whatever a message is made of', async () => {
		const [row] = await env.db.select().from(webhooks).where(eq(webhooks.id, staff.id));
		const embeds = [{ title: 'T', description: '@everyone', color: 0, timestamp: card().at }];
		// what is not a list of roles' numbers pings nothing and adds nothing to the message
		for (const no of [
			['@everyone'],
			['everyone', '@here'],
			[`${STAFF}> @everyone`],
			[`<@&${STAFF}>`],
			['1'],
			[],
			null,
			STAFF,
			`${STAFF} ${MODS}`,
			{ 0: STAFF, length: 1 }
		]) {
			await postDiscord(env, row, { embeds }, no as never);
			expect({ no, ...how(posts.pop()) }).toEqual({ no, ...QUIET });
		}
		// of a list, the roles' numbers are pinged, each once, and nothing else in it; five at most
		await postDiscord(env, row, { embeds }, [STAFF, '@everyone', MODS, 'x', STAFF] as never);
		expect(how(posts.pop())).toEqual({
			content: `<@&${STAFF}> <@&${MODS}>`,
			mentions: { parse: [], roles: [STAFF, MODS] }
		});
		const seven = ['1', '2', '3', '4', '5', '6', '7'].map((n) => `44444444444444444${n}`);
		await postDiscord(env, row, { embeds }, seven);
		expect((posts.pop()?.mentions as { roles: string[] }).roles).toEqual(seven.slice(0, 5));
		// a message with words of its own keeps them after the roles, and Discord is still allowed
		// the roles alone
		await postDiscord(env, row, { content: `@everyone <@&${BIG}>`, embeds }, [STAFF]);
		expect(how(posts.pop())).toEqual({
			content: `<@&${STAFF}> @everyone <@&${BIG}>`,
			mentions: { parse: [], roles: [STAFF] }
		});
		// without roles, words of its own ping nobody
		await postDiscord(env, row, { content: `@everyone <@&${STAFF}>`, embeds });
		expect(posts.pop()?.mentions).toEqual({ parse: [] });
		// and a message cannot widen what Discord is allowed, posted or edited
		const wide = { embeds, allowed_mentions: { parse: ['everyone', 'roles', 'users'] } } as never;
		await postDiscord(env, row, wide);
		expect(posts.pop()?.mentions).toEqual({ parse: [] });
		await postDiscord(env, row, wide, [STAFF]);
		expect(posts.pop()?.mentions).toEqual({ parse: [], roles: [STAFF] });
		await editDiscord(env, row, '1', wide);
		expect(posts.pop()?.mentions).toEqual({ parse: [] });
	});

	test('a list of roles stored some other way pings the roles in it and nothing else', async () => {
		// not through the panel, which refuses such a list: straight into the row
		await env.db
			.update(webhooks)
			.set({ staffRoleIds: [STAFF, '@everyone', `<@&${BIG}>`, 7, null, SENIOR] })
			.where(eq(webhooks.id, staff.id));
		resetWebhookQueues();
		await call();
		expect(how((await sent()).staff[0])).toEqual(PING(STAFF, SENIOR));
		const list = await callApi(listRoute, w.users.owner, { params: { id: w.org.id } });
		expect((list.body as { webhooks: WebhookView[] }).webhooks[0].staffRoleIds).toEqual([
			STAFF,
			SENIOR
		]);
		// and one that is no list at all pings nobody
		await env.db
			.update(webhooks)
			.set({ staffRoleIds: '@everyone' })
			.where(eq(webhooks.id, staff.id));
		resetWebhookQueues();
		await call();
		expect(how((await sent()).staff[0])).toEqual(QUIET);
		expect((await edit('owner', [STAFF])).status).toBe(200);
	}, 20_000);

	test('the test message names the roles in the card and pings nobody', async () => {
		const press = (hook: WebhookView, who: PrincipalName = 'owner') =>
			callApi(testRoute, w.users[who], {
				method: 'POST',
				params: { id: w.org.id, webhookId: hook.id }
			});
		expect((await press(staff)).status).toBe(200);
		expect((await press(plain)).status).toBe(200);
		expect((await press(unticked)).status).toBe(200);
		expect((await press(mods)).status).toBe(200);
		expect((await press(staff, 'admin')).status).toBe(403);
		expect((await press(staff, 'keyAll')).status).toBe(403);
		const [named, bare, off, two] = posts;
		expect(posts.length).toBe(4);
		for (const p of posts) expect(how(p)).toEqual(QUIET);
		expect(named.text).toContain(`A Staff call here pings <@&${STAFF}>`);
		expect(named.text).toContain('This test pings nobody.');
		expect(two.text).toContain(`A Staff call here pings <@&${MODS}> <@&${SENIOR}>,`);
		expect(bare.text).not.toContain('<@&');
		// a role on a webhook that takes no Staff calls pings nobody, and the test does not say it does
		expect(off.text).not.toContain('<@&');
	});
});
