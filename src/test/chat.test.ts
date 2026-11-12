// Season 3's in-game chat, end to end against the demo game: the game's chat terms are read by
// those who hold Read chat and accepted by an owner of the server's organisation, in person (never
// a key, never a role); until then the game serves no chat and holds its event feed back. The
// lines are players' messages: they reach those who hold Read chat (owners until a role is given
// it; no built-in role has it, and no API key can), and the panel keeps none of them. Raw RCON is
// no way round either rule. Who gets which answer from each action is also in action-matrix.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import { auditLog, orgRoles } from '$lib/server/db/schema';
import { setGateway } from '$lib/server/gateway';
import { PRIORITY } from '$lib/server/dispatcher';
import { isPrivileged } from '$lib/server/enrolment';
import { localGateway } from '$lib/server/gateway-local';
import { setMockFeed } from '$lib/server/mockgame';
import { WardogsClient } from '$lib/server/rcon';
import { feedDiagnosis, type FeedReport } from '$lib/feed-report';
import type { ChatRead, ChatTerms } from '$lib/chat-read';
import { CAPABILITIES, type Capability } from '$lib/capabilities';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway, type CallInput } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const ORIGIN = 'https://panel.example';

describe.skipIf(!hasTestDb)('In-game chat', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	/** the demo game each server of the world talks to */
	const gameKey = (serverId: string) => `chat-${serverId}`;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		setGateway(localGateway);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async (_env, server) =>
				new WardogsClient(
					env,
					{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
					'demo',
					gameKey(server.id)
				)
		);
	});

	afterAll(() => {
		spy?.mockRestore();
		stubGateway();
	});

	/** the roles route, asked to give the viewer's role these besides View */
	const role = async (who: SessionUser | null, caps: Capability[]) => {
		const { PATCH } = await import(join(ROUTES, 'orgs/[id]/roles/[roleId]', '+server.ts'));
		return callApi(PATCH, who, {
			method: 'PATCH',
			params: { id: w.org.id, roleId: w.roles.viewer },
			body: { capabilities: ['server.view', ...caps] }
		});
	};
	/** an owner gives the viewer's role these besides View, as on the Roles tab */
	const holds = async (caps: Capability[]) => {
		expect((await role(w.users.owner, caps)).status).toBe(200);
		const [row] = await env.db.select().from(orgRoles).where(eq(orgRoles.id, w.roles.viewer));
		expect(row.capabilities).toEqual(['server.view', ...caps]);
	};

	const rcon = async (
		who: SessionUser | null,
		method: 'GET' | 'POST',
		action: string,
		input: Omit<CallInput, 'method' | 'params'> = {},
		serverId = w.server.id
	) => {
		const mod = await import(join(ROUTES, 'servers/[id]/rcon/[action]', '+server.ts'));
		return callApi(mod[method], who, { ...input, method, params: { id: serverId, action } });
	};
	const result = <T>(answer: { body: unknown }) => (answer.body as { result: T }).result;
	const trail = (action: string) =>
		env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.action, action)))
			.orderBy(auditLog.id);

	test('the terms are read by those who hold Read chat, which no built-in role does', async () => {
		const people = ['anon', 'viewer', 'operator', 'admin', 'elsewhere', 'owner', 'site', 'keyAll'];
		const read = async () => {
			const got: Record<string, number> = {};
			for (const who of people)
				got[who] = (await rcon(w.users[who as keyof World['users']], 'GET', 'chatTerms')).status;
			return got;
		};
		expect(await read()).toEqual({
			anon: 401,
			viewer: 403,
			operator: 403,
			admin: 403,
			elsewhere: 404,
			owner: 200,
			site: 200,
			// a key over everything, whose row lists every capability, holds none that is a person's
			keyAll: 403
		});
		// only an owner puts it on a role: not the role's own people, an admin (here or on the
		// organisation's other server) or a key; and nobody from outside or signed out
		for (const who of [w.users.viewer, w.users.admin, w.users.elsewhere, w.users.keyAll])
			expect((await role(who, ['chat.read'])).status).toBe(403);
		expect((await role(w.users.outsider, ['chat.read'])).status).toBe(404);
		expect((await role(null, ['chat.read'])).status).toBe(401);
		expect((await read()).viewer).toBe(403);
		// an owner gives it to a role: the people on that role read the terms, and nobody else gains
		await holds(['chat.read']);
		expect(await read()).toMatchObject({ viewer: 200, operator: 403, admin: 403, keyAll: 403 });
		const terms = result<ChatTerms>(await rcon(w.users.viewer, 'GET', 'chatTerms'));
		expect(terms).toMatchObject({ requiredVersion: 1, acceptedVersion: 0, accepted: false });
		expect(terms.text).toContain('moderated');
	});

	test('until they are accepted the game serves no chat', async () => {
		for (const who of [w.users.owner, w.users.viewer]) {
			const got = await rcon(who, 'GET', 'chat');
			expect([got.status, got.code]).toEqual([409, 'chat_terms_not_accepted']);
		}
	});

	test('accepting them is an owner’s, in person, for the version the server asks for', async () => {
		const accept = (who: SessionUser | null, body: Record<string, unknown> = { version: 1 }) =>
			rcon(who, 'POST', 'chatTermsAccept', { body });
		// the role that reads chat does not accept for the organisation, nor does an admin
		for (const who of [w.users.viewer, w.users.admin, w.users.operator]) {
			const got = await accept(who);
			expect([got.status, got.code]).toEqual([403, 'forbidden']);
			expect(got.message).toContain('Only an owner of the organisation');
		}
		// nor a key, whatever it carries; nor anyone outside
		const key = await accept(w.users.keyAll);
		expect([key.status, key.code]).toEqual([403, 'api_key_forbidden']);
		expect((await accept(w.users.keyElsewhere)).code).toBe('api_key_forbidden');
		expect((await accept(w.users.elsewhere)).status).toBe(404);
		expect((await accept(null)).status).toBe(401);
		expect((await rcon(w.users.owner, 'GET', 'chatTermsAccept')).status).toBe(405);
		const still = result<ChatTerms>(await rcon(w.users.owner, 'GET', 'chatTerms'));
		expect(still.accepted).toBe(false);
		// Each refusal is in the trail as denied: the people's, and the key's that can see the
		// server. The key held to another server got the same answer and left nothing here.
		const denied = (await trail('rcon.chatTermsAccept')).filter((r) => r.outcome === 'denied');
		expect(denied.map((r) => r.actorId).sort()).toEqual(
			[w.users.viewer!.id, w.users.admin!.id, w.users.operator!.id, w.users.keyAll!.id].sort()
		);
		expect(denied.find((r) => r.actorId === w.users.keyAll!.id)!.message).toBe(
			'Needs an owner of the organisation in person, an API key is not one'
		);

		// an owner, for a version the server does not ask for, and for none
		const wrong = await accept(w.users.owner, { version: 2 });
		expect([wrong.status, wrong.code]).toEqual([400, 'terms_version_mismatch']);
		const none = await accept(w.users.owner, {});
		expect([none.status, none.code]).toEqual([400, 'missing_version']);
		expect(result<ChatTerms>(await rcon(w.users.owner, 'GET', 'chatTerms')).accepted).toBe(false);

		// and for the one it does
		const done = await accept(w.users.owner);
		expect(done.status).toBe(200);
		expect(result<{ message: string; pending: boolean }>(done)).toEqual({
			message: 'Chat terms version 1 accepted.',
			pending: false
		});
		expect(result<ChatTerms>(await rcon(w.users.viewer, 'GET', 'chatTerms'))).toMatchObject({
			acceptedVersion: 1,
			accepted: true
		});
		const rows = await trail('rcon.chatTermsAccept');
		const ok = rows.filter((r) => r.outcome === 'ok');
		expect(ok).toHaveLength(1);
		expect(ok[0]).toMatchObject({
			actorId: w.users.owner!.id,
			category: 'rcon',
			target: 'version 1',
			message: 'Chat terms version 1 accepted.',
			detail: { version: 1 }
		});
		// the two refused by the game or for naming no version, each with what it named
		expect(
			rows.filter((r) => r.outcome === 'error').map((r) => [r.status, r.target, r.detail])
		).toEqual([
			[400, 'version 2', { version: 2 }],
			[400, '', { version: 0 }]
		]);
	});

	test('then the lines reach those who hold Read chat, and the panel keeps none of them', async () => {
		const first = await rcon(w.users.viewer, 'GET', 'chat');
		expect(first.status).toBe(200);
		const read = result<ChatRead>(first);
		expect(read.lines.length).toBeGreaterThan(0);
		expect(read.latestSeq).toBe(read.lines[read.lines.length - 1].seq);
		const line = read.lines[0];
		expect(Object.keys(line).sort()).toEqual(
			[
				'anonymous',
				'at',
				'channel',
				'faction',
				'hiddenName',
				'name',
				'ping',
				'seq',
				'steamId',
				'text',
				'typed'
			].sort()
		);
		expect(line.text.length).toBeGreaterThan(0);
		expect(line.name.length).toBeGreaterThan(0);
		// from a line on, and so many at a time
		const later = result<ChatRead>(
			await rcon(w.users.owner, 'GET', 'chat', { query: `after=${read.lines[0].seq}&limit=2` })
		);
		expect(later.lines.every((l) => l.seq > read.lines[0].seq)).toBe(true);
		expect(later.lines.length).toBeLessThanOrEqual(2);
		const caughtUp = result<ChatRead>(
			await rcon(w.users.owner, 'GET', 'chat', { query: `after=${read.latestSeq! + 1000}` })
		);
		expect(caughtUp.lines).toEqual([]);

		// not the roles without it, not a key, not another organisation's people
		for (const who of [w.users.operator, w.users.admin, w.users.keyAll, w.users.keyView])
			expect((await rcon(who, 'GET', 'chat')).status).toBe(403);
		// nor a key whose principal carries it all the same (made by hand here: one read from a
		// key's row never does)
		const carrying: SessionUser = {
			...w.users.keyAll!,
			apiKey: { ...w.users.keyAll!.apiKey!, capabilities: [...CAPABILITIES] }
		};
		expect((await rcon(carrying, 'GET', 'chat')).status).toBe(403);
		expect((await rcon(carrying, 'GET', 'chatTerms')).status).toBe(403);
		expect((await rcon(w.users.elsewhere, 'GET', 'chat')).status).toBe(404);
		expect((await rcon(w.users.outsider, 'GET', 'chat')).status).toBe(404);
		expect((await rcon(null, 'GET', 'chat')).status).toBe(401);
		// taken from the role again, the people on it are refused again
		await holds([]);
		expect((await rcon(w.users.viewer, 'GET', 'chat')).status).toBe(403);
		await holds(['chat.read']);

		// A read leaves no row in the trail (only the refusals above do, as every refusal does), and
		// no line's words are anywhere in it.
		for (const action of ['rcon.chat', 'rcon.chatTerms']) {
			const rows = await trail(action);
			expect(rows.filter((r) => r.outcome !== 'denied')).toEqual([]);
			expect(rows.length).toBeGreaterThan(0);
		}
		const everything = JSON.stringify(
			await env.db.select().from(auditLog).where(eq(auditLog.serverId, w.server.id))
		);
		for (const l of read.lines) {
			expect(everything).not.toContain(l.text);
			if (l.hiddenName) expect(everything).not.toContain(l.hiddenName);
		}
	});

	test('with reads audited too, a read is a row that holds none of its lines', async () => {
		const settings = env as { AUDIT_LOG_READS?: string };
		const was = settings.AUDIT_LOG_READS;
		settings.AUDIT_LOG_READS = 'true';
		try {
			const read = result<ChatRead>(await rcon(w.users.owner, 'GET', 'chat'));
			expect(read.lines.length).toBeGreaterThan(0);
			expect((await rcon(w.users.owner, 'GET', 'chatTerms')).status).toBe(200);
			const rows = [...(await trail('rcon.chat')), ...(await trail('rcon.chatTerms'))].filter(
				(r) => r.outcome === 'ok'
			);
			expect(rows.map((r) => r.action).sort()).toEqual(['rcon.chat', 'rcon.chatTerms']);
			for (const r of rows) expect([r.message, r.target, r.detail]).toEqual(['', '', null]);
			const everything = JSON.stringify(
				await env.db.select().from(auditLog).where(eq(auditLog.serverId, w.server.id))
			);
			for (const l of read.lines) {
				expect(everything).not.toContain(l.text);
				if (l.hiddenName) expect(everything).not.toContain(l.hiddenName);
			}
		} finally {
			settings.AUDIT_LOG_READS = was;
		}
	});

	test('the tab’s reads take their turn behind commands and rules in the server’s lane', async () => {
		const seen: [string, number | undefined][] = [];
		setGateway({
			...localGateway,
			run: (e, server, action, params, priority) => {
				seen.push([action, priority]);
				return localGateway.run(e, server, action, params, priority);
			}
		});
		try {
			await rcon(w.users.owner, 'GET', 'chat');
			await rcon(w.users.owner, 'GET', 'chatTerms');
			await rcon(w.users.owner, 'GET', 'status');
			await rcon(w.users.owner, 'POST', 'chatTermsAccept', { body: { version: 1 } });
		} finally {
			setGateway(localGateway);
		}
		expect(seen).toEqual([
			['chat', PRIORITY.observe],
			['chatTerms', PRIORITY.observe],
			['status', undefined],
			['chatTermsAccept', undefined]
		]);
	});

	test('a role that reads chat makes its people accounts the sign-in rules protect', async () => {
		const viewer = { id: w.users.viewer!.id, role: 'member' as const };
		expect(await isPrivileged(env, viewer)).toBe(true);
		await holds([]);
		expect(await isPrivileged(env, viewer)).toBe(false);
		await holds(['chat.read']);
	});

	test('raw is no way round: neither the lines nor the terms are served through it', async () => {
		const raw = (who: SessionUser | null, method: string, path: string, body?: unknown) =>
			rcon(who, 'POST', 'raw', { body: { method, path, ...(body ? { body } : {}) } });
		for (const [method, path, body] of [
			['GET', '/v1/chat', undefined],
			['GET', '/v1/chat?after=0&limit=500', undefined],
			['GET', '/v1/chat/terms', undefined],
			['POST', '/v1/chat/terms', { version: 1 }],
			['GET', '/v1/CHAT', undefined]
		] as const) {
			const got = await raw(w.users.owner, method, path, body);
			expect([path, got.status, got.code]).toEqual([path, 403, 'use_chat']);
		}
		// what is not chat goes through as before
		expect((await raw(w.users.owner, 'GET', '/v1/health')).status).toBe(200);
	});

	test('an API key is not given Read chat', async () => {
		const { POST } = await import(join(ROUTES, 'orgs/[id]/keys', '+server.ts'));
		const mint = (capabilities: string[]) =>
			callApi(POST, w.users.owner, {
				method: 'POST',
				params: { id: w.org.id },
				body: { label: 'chat bot', capabilities, serverIds: null }
			});
		const refused = await mint(['server.view', 'chat.read']);
		expect(refused.status).toBe(400);
		expect(refused.message).toContain("'Read chat' is for people, not for an API key");
		expect((await mint(['server.view', 'chat.send'])).status).toBe(201);
	});

	test('the list of actions says which is an owner’s alone', async () => {
		const { GET } = await import(join(ROUTES, 'actions', '+server.ts'));
		const got = await callApi(GET, w.users.viewer, { method: 'GET', params: {} });
		const actions = (got.body as { actions: Record<string, unknown> }).actions;
		expect(actions.chatTermsAccept).toEqual({ cap: 'chat.read', mutating: true, owner: true });
		expect(actions.chat).toEqual({ cap: 'chat.read', mutating: false });
		expect(actions.chatTerms).toEqual({ cap: 'chat.read', mutating: false });
		// no other action is marked so
		expect(
			Object.entries(actions)
				.filter(([, a]) => (a as { owner?: boolean }).owner)
				.map(([name]) => name)
		).toEqual(['chatTermsAccept']);
	});

	test('the event feed is held back until the terms are accepted, and the report says so', async () => {
		const season3 = {
			enabled: true,
			endpointCount: 1,
			anyUnhealthy: false,
			pausedForTerms: true,
			endpoints: [
				{
					index: 0,
					scheme: 'https',
					host: 'panel.example',
					healthy: true,
					queued: 0,
					inFlight: 0,
					consecutiveFailures: 0,
					sentTotal: 0,
					droppedTotal: 0,
					lastHttpStatus: null,
					lastSuccessUnixSeconds: null
				}
			]
		};
		// the server whose terms an owner accepted above, and the organisation's other one
		setMockFeed(gameKey(w.server.id), season3);
		setMockFeed(gameKey(w.otherServer.id), season3);
		const feed = async (serverId: string) =>
			result<FeedReport>(await rcon(w.users.owner, 'GET', 'feed', {}, serverId));
		const here = await feed(w.server.id);
		const there = await feed(w.otherServer.id);
		expect([here.pausedForTerms, there.pausedForTerms]).toEqual([false, true]);
		expect(feedDiagnosis(here, ORIGIN, 'silent').fault).toBeNull();
		expect(feedDiagnosis(there, ORIGIN, 'silent').fault).toBe('terms');
		// accepted there too, by an owner: the game lets its feed go
		expect(
			(
				await rcon(
					w.users.owner,
					'POST',
					'chatTermsAccept',
					{ body: { version: 1 } },
					w.otherServer.id
				)
			).status
		).toBe(200);
		expect((await feed(w.otherServer.id)).pausedForTerms).toBe(false);
	});
});
