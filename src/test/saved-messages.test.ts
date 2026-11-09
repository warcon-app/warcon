// The org's saved messages, the ready-made lines its staff pick in the chat boxes: what a list may
// hold, who may change it (an owner of the org, never a key), who may read it (whoever may chat
// on the server the box is on), and that one org's list never reaches another.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import { savedMessagesView } from '$lib/server/saved-messages';
import { auditLog, orgMembers, orgSavedMessages, organizations, user } from '$lib/server/db/schema';
import {
	cleanSavedMessage,
	findSaved,
	MAX_SAVED_MESSAGES,
	savedMessagesProblem,
	storedSavedMessages,
	type SavedMessage
} from '$lib/saved-messages';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { PRINCIPALS, seedWorld, suspend, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const LIST: SavedMessage[] = [
	{ name: 'Team killing', text: 'Team killing will not be tolerated. Watch your fire.' },
	{ name: 'Restart soon', text: 'The server restarts in 5 minutes.' },
	{ name: 'Join EU #2', text: 'This server is emptying out. Join us on EU #2.' }
];
const many = (n: number): SavedMessage[] =>
	Array.from({ length: n }, (_, i) => ({ name: `M${i}`, text: `Message ${i}` }));

describe('a list of saved messages', () => {
	test('each text is one line, cut to its cap, never half an emoji', () => {
		expect(cleanSavedMessage({ name: '  Team\n killing ', text: 'a\tb \r\n  c\u0007d' })).toEqual({
			name: 'Team killing',
			text: 'a b c d'
		});
		expect(cleanSavedMessage({ name: 'x'.repeat(60), text: 'y'.repeat(300) })).toEqual({
			name: 'x'.repeat(48),
			text: 'y'.repeat(256)
		});
		// 255 units then an emoji (two units): the emoji does not fit, and is not cut in half
		const text = cleanSavedMessage({ name: 'n', text: 'y'.repeat(255) + '🎯' }).text;
		expect(text).toBe('y'.repeat(255));
		expect(cleanSavedMessage({ name: 'n', text: 'y'.repeat(254) + '🎯' }).text).toBe(
			'y'.repeat(254) + '🎯'
		);
		expect(cleanSavedMessage('not an object')).toEqual({ name: '', text: '' });
		expect(cleanSavedMessage({ name: 7, text: null })).toEqual({ name: '7', text: '' });
	});

	test('half an emoji anywhere becomes the replacement character, which jsonb takes', () => {
		// Postgres refuses a lone surrogate in jsonb: kept as sent, the save was a 500
		expect(cleanSavedMessage({ name: 'a\uD800b', text: 'x\uDC00y \uD83C' })).toEqual({
			name: 'a�b',
			text: 'x�y �'
		});
		expect(cleanSavedMessage({ name: 'n', text: 'ok 🎯' }).text).toBe('ok 🎯');
	});

	test('each needs a name and a text, and no two share a name', () => {
		expect(savedMessagesProblem(LIST)).toBe('');
		expect(savedMessagesProblem([])).toBe('');
		expect(savedMessagesProblem([...LIST, { name: '', text: 'x' }])).toMatch(/a name and a text/);
		expect(savedMessagesProblem([...LIST, { name: 'x', text: '' }])).toMatch(/a name and a text/);
		expect(savedMessagesProblem([...LIST, { name: 'TEAM KILLING', text: 'x' }])).toMatch(
			/same name/
		);
	});

	test('an org keeps at most fifty', () => {
		expect(savedMessagesProblem(many(MAX_SAVED_MESSAGES))).toBe('');
		expect(savedMessagesProblem(many(MAX_SAVED_MESSAGES + 1))).toMatch(/at most 50/);
	});

	test('a stored list is read leaving out whatever would not save', () => {
		expect(storedSavedMessages('not a list')).toEqual([]);
		expect(storedSavedMessages(null)).toEqual([]);
		expect(
			storedSavedMessages([
				LIST[0],
				{ name: 'team KILLING', text: 'a second Team killing' },
				{ name: '', text: 'no name' },
				'a string',
				LIST[1]
			])
		).toEqual([LIST[0], LIST[1]]);
	});

	test("the picker's search finds a name or a text, in the list's order", () => {
		expect(findSaved(LIST, '')).toEqual(LIST);
		expect(findSaved(LIST, '  ')).toEqual(LIST);
		expect(findSaved(LIST, 'RESTART')).toEqual([LIST[1]]);
		expect(findSaved(LIST, 'server')).toEqual([LIST[1], LIST[2]]);
		expect(findSaved(LIST, 'nothing like it')).toEqual([]);
	});
});

describe.skipIf(!hasTestDb)("an org's saved messages", () => {
	let env: Env;
	let w: World;
	const as = (who: PrincipalName | SessionUser) => (typeof who === 'string' ? w.users[who] : who);

	const patch = async (
		who: PrincipalName | SessionUser,
		savedMessages: unknown,
		orgId = w.org.id
	) => {
		const mod = await import(join(ROUTES, 'orgs/[id]', '+server.ts'));
		return callApi(mod.PATCH, as(who), {
			method: 'PATCH',
			params: { id: orgId },
			body: { savedMessages }
		});
	};
	const stored = async (orgId = w.org.id) =>
		(await env.db.select().from(orgSavedMessages).where(eq(orgSavedMessages.orgId, orgId)))[0] ??
		null;
	/** what a server's chat boxes are handed */
	const read = async (who: PrincipalName | SessionUser, serverId = w.server.id) => {
		const mod = await import(join(ROUTES, 'servers/[id]/saved-messages', '+server.ts'));
		return callApi(mod.GET, as(who), { params: { id: serverId } });
	};
	const messagesIn = (answer: { body: unknown }) =>
		(answer.body as { messages?: SavedMessage[] }).messages;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
	});

	test('an org that never saved any has none', async () => {
		expect(messagesIn(await read('operator'))).toEqual([]);
		expect(await savedMessagesView(env, w.org.id)).toEqual({
			savedMessages: [],
			savedAt: null,
			savedBy: null
		});
	});

	test('only an owner of the org changes them, and never through a key', async () => {
		for (const who of PRINCIPALS.filter((p) => p !== 'owner' && p !== 'site')) {
			const answer = await patch(who, LIST);
			expect({ who, refused: answer.status >= 400 }).toEqual({ who, refused: true });
			expect(await stored()).toBeNull();
		}
		// an owner of one org cannot reach another's
		expect((await patch('owner', LIST, w.otherOrg.id)).status).toBe(404);
		expect(await stored(w.otherOrg.id)).toBeNull();

		const answer = await patch('owner', LIST);
		expect(answer.status).toBe(200);
		expect((answer.body as { savedMessages: SavedMessage[] }).savedMessages).toEqual(LIST);
		expect(await stored()).toMatchObject({ messages: LIST, updatedBy: w.users.owner!.id });
	});

	test('the site owner changes them too', async () => {
		const answer = await patch('site', [...LIST, { name: 'Site', text: 'From the site owner.' }]);
		expect(answer.status).toBe(200);
		expect((await stored())?.updatedBy).toBe(w.users.site!.id);
		expect((await patch('owner', LIST)).status).toBe(200);
	});

	test('the change is in the audit trail with the list it saved', async () => {
		const [row] = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'org.saved_messages')))
			.orderBy(desc(auditLog.id))
			.limit(1);
		expect(row).toMatchObject({
			actorId: w.users.owner!.id,
			category: 'org',
			outcome: 'ok',
			message: 'Saved messages changed'
		});
		expect((row.detail as { savedMessages: SavedMessage[] }).savedMessages).toEqual(LIST);
	});

	test('the editor shows when they were last saved and by whom', async () => {
		const view = await savedMessagesView(env, w.org.id);
		expect(view.savedMessages).toEqual(LIST);
		expect(view.savedBy).toBe(w.users.owner!.username);
		expect(Date.now() - Date.parse(view.savedAt!)).toBeLessThan(60_000);
	});

	test('a list that would not save is refused and changes nothing', async () => {
		for (const bad of [
			'Team killing',
			null,
			{ name: 'Team killing', text: 'not in a list' },
			[...LIST, { name: 'team KILLING', text: 'a second Team killing' }],
			[...LIST, { name: 'Empty', text: '   ' }],
			[...LIST, { name: '\n', text: 'no name' }],
			many(MAX_SAVED_MESSAGES + 1)
		]) {
			const answer = await patch('owner', bad);
			expect({ bad, status: answer.status }).toEqual({ bad, status: 400 });
			expect((await stored())?.messages).toEqual(LIST);
		}
	});

	test('a lone surrogate is saved as the replacement character, not a 500', async () => {
		const answer = await patch('owner', [{ name: 'Lone\uD800', text: 'a\uD800b x\uDC00y' }]);
		expect(answer.status).toBe(200);
		expect((await stored())?.messages).toEqual([{ name: 'Lone�', text: 'a�b x�y' }]);
		expect((await patch('owner', LIST)).status).toBe(200);
	});

	test('whoever may chat on the server reads them, and nobody else', async () => {
		// Chat on this server: the operator and admin roles, owners, the site owner, a full key
		for (const who of ['owner', 'site', 'operator', 'admin', 'keyAll'] as PrincipalName[])
			expect({ who, messages: messagesIn(await read(who)) }).toEqual({ who, messages: LIST });
		// on the server without Chat: View is what is happening, not how the server is run
		for (const who of ['viewer', 'orgBans', 'orgSlots', 'keyView', 'keyBans'] as PrincipalName[])
			expect({ who, status: (await read(who)).status }).toEqual({ who, status: 403 });
		expect((await read('anon')).status).toBe(401);
		// cannot see the server at all
		for (const who of [
			'stranger',
			'outsider',
			'member',
			'elsewhere',
			'keyElsewhere'
		] as PrincipalName[])
			expect({ who, status: (await read(who)).status }).toEqual({ who, status: 404 });
	});

	test("the list is the whole org's: Chat on another of its servers reads it there", async () => {
		for (const who of ['elsewhere', 'keyElsewhere'] as PrincipalName[])
			expect({ who, messages: messagesIn(await read(who, w.otherServer.id)) }).toEqual({
				who,
				messages: LIST
			});
	});

	test("one org's list never reaches another's servers", async () => {
		expect(messagesIn(await read('outsider', w.otherOrgServer.id))).toEqual([]);
		expect((await read('owner', w.otherOrgServer.id)).status).toBe(404);
	});

	test('an empty list offers none and keeps who emptied it', async () => {
		expect((await patch('owner', [])).status).toBe(200);
		expect(await stored()).toMatchObject({ messages: [], updatedBy: w.users.owner!.id });
		expect(messagesIn(await read('operator'))).toEqual([]);
		expect((await patch('owner', LIST)).status).toBe(200);
	});

	test('a deleted account leaves the list, without its name', async () => {
		const id = `u_second_owner_${w.org.id}`;
		await env.db.insert(user).values({
			id,
			name: id,
			email: `${id}@test.invalid`,
			username: id,
			displayUsername: id,
			role: 'member',
			authComplete: true
		});
		await env.db.insert(orgMembers).values({ orgId: w.org.id, userId: id, role: 'owner' });
		const second: SessionUser = {
			id,
			username: id,
			name: id,
			role: 'member',
			mustChangePassword: false,
			image: null,
			defaultOrgId: null,
			authComplete: true,
			authGraceStartedAt: null
		};
		expect((await patch(second, LIST)).status).toBe(200);
		expect((await savedMessagesView(env, w.org.id)).savedBy).toBe(id);

		await env.db.delete(user).where(eq(user.id, id));
		expect(await stored()).toMatchObject({ messages: LIST, updatedBy: null });
		const view = await savedMessagesView(env, w.org.id);
		expect(view).toMatchObject({ savedMessages: LIST, savedBy: null });
		expect(view.savedAt).not.toBeNull();
	});

	test("a suspended org's owners cannot change them, nor its staff read them", async () => {
		await suspend(env, w.org.id);
		try {
			expect((await patch('owner', [])).status).toBe(403);
			expect((await stored())?.messages).toEqual(LIST);
			expect((await read('operator')).status).toBe(404);
		} finally {
			await env.db
				.update(organizations)
				.set({ suspendedAt: null, suspendedReason: '' })
				.where(eq(organizations.id, w.org.id));
		}
	});
});
