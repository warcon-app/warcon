// The org's quick reasons, the buttons under Reason in the ban dialog: what a list may hold, who
// may change it (an owner of the org, never a key), who may read it (whoever may place a ban there),
// and that one org's list never reaches another.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import {
	auditLog,
	orgBanReasons,
	orgMembers,
	orgRoles,
	organizations,
	serverGrants,
	user
} from '$lib/server/db/schema';
import {
	BAN_REASON_DAYS,
	banReasonsProblem,
	cleanBanReason,
	DEFAULT_BAN_REASONS,
	lengthLabel,
	lengthTag,
	MAX_BAN_REASONS,
	storedBanReasons,
	type BanReason
} from '$lib/ban-reasons';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, suspend, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const PLAYER = '76561198000000092';
const LIST: BanReason[] = [
	{ label: 'Rule one', reason: '7 day ban: broke rule one. Appeal at example.org', days: 7 },
	{ label: 'Rule two', reason: 'Broke rule two', days: null },
	{ label: 'Rule three', reason: 'Permanent ban: broke rule three', days: 0 }
];
const many = (n: number): BanReason[] =>
	Array.from({ length: n }, (_, i) => ({ label: `R${i}`, reason: `Reason ${i}`, days: null }));

describe('a list of quick reasons', () => {
	test('each text is one line, cut to its cap', () => {
		expect(cleanBanReason({ label: '  Rule\n one ', reason: 'a\tb   c', days: 3 })).toEqual({
			label: 'Rule one',
			reason: 'a b c',
			days: 3
		});
		expect(cleanBanReason({ label: 'x'.repeat(40), reason: 'y'.repeat(250) })).toEqual({
			label: 'x'.repeat(32),
			reason: 'y'.repeat(200),
			days: null
		});
	});

	test("a length is one of the ban dialog's own choices, or none", () => {
		expect(BAN_REASON_DAYS).toEqual([0, 1, 3, 7, 14, 30]);
		for (const days of [null, ...BAN_REASON_DAYS])
			expect({ days, problem: banReasonsProblem([{ ...LIST[0], days }]) }).toEqual({
				days,
				problem: ''
			});
		for (const days of [2, -1, 365, 1.5, NaN])
			expect(banReasonsProblem([{ ...LIST[0], days }])).toMatch(/^A length is one of/);
		expect(cleanBanReason({ label: 'a', reason: 'b', days: '7' }).days).toBeNaN();
	});

	test('each needs a short name and a reason, and no two share a name', () => {
		expect(banReasonsProblem(LIST)).toBe('');
		expect(banReasonsProblem([...LIST, { label: '', reason: 'x', days: null }])).toMatch(
			/short name and a reason/
		);
		expect(banReasonsProblem([...LIST, { label: 'x', reason: '', days: null }])).toMatch(
			/short name and a reason/
		);
		expect(banReasonsProblem([...LIST, { label: 'RULE ONE', reason: 'x', days: null }])).toMatch(
			/same short name/
		);
	});

	test('an org keeps at most twenty', () => {
		expect(banReasonsProblem(many(MAX_BAN_REASONS))).toBe('');
		expect(banReasonsProblem(many(MAX_BAN_REASONS + 1))).toMatch(/at most 20/);
	});

	test('a stored list is read leaving out whatever would not save', () => {
		expect(storedBanReasons('not a list')).toEqual(DEFAULT_BAN_REASONS);
		expect(
			storedBanReasons([
				LIST[0],
				{ label: 'rule one', reason: 'a second Rule one' },
				{ label: '', reason: 'no name' },
				LIST[1]
			])
		).toEqual([LIST[0], LIST[1]]);
	});

	test('a length reads as the editor and the buttons show it', () => {
		expect([null, 0, 1, 7].map(lengthLabel)).toEqual(['Not set', 'Permanent', '1 day', '7 days']);
		expect([null, 0, 3].map(lengthTag)).toEqual(['', 'Perm', '3d']);
	});
});

describe.skipIf(!hasTestDb)("an org's quick reasons", () => {
	let env: Env;
	let w: World;
	/** Bans on the server and no org list: what a server-only moderator role holds */
	let bansOnly: SessionUser;
	const as = (who: PrincipalName | SessionUser) => (typeof who === 'string' ? w.users[who] : who);

	const patch = async (who: PrincipalName | SessionUser, banReasons: unknown, orgId = w.org.id) => {
		const mod = await import(join(ROUTES, 'orgs/[id]', '+server.ts'));
		return callApi(mod.PATCH, as(who), {
			method: 'PATCH',
			params: { id: orgId },
			body: { banReasons }
		});
	};
	const stored = async (orgId = w.org.id) =>
		(await env.db.select().from(orgBanReasons).where(eq(orgBanReasons.orgId, orgId)))[0]?.reasons ??
		null;

	/** what a server's Bans and Players tabs hand the dialog */
	const state = async (who: PrincipalName | SessionUser, serverId = w.server.id) => {
		const mod = await import(join(ROUTES, 'servers/[id]/lists/state', '+server.ts'));
		return callApi(mod.GET, as(who), { params: { id: serverId } });
	};
	/** what the org's Ban list and Players pages hand the dialog (the org layout reads the same) */
	const orgLists = async (who: PrincipalName | SessionUser) => {
		const mod = await import(join(ROUTES, 'orgs/[id]/lists', '+server.ts'));
		return callApi(mod.GET, as(who), { params: { id: w.org.id } });
	};
	/** what a dossier's Ban org-wide hands the dialog */
	const dossier = async (who: PrincipalName | SessionUser) => {
		const mod = await import(join(ROUTES, 'servers/[id]/players/[steamId]', '+server.ts'));
		return callApi(mod.GET, as(who), { params: { id: w.server.id, steamId: PLAYER } });
	};
	const reasonsIn = (answer: { body: unknown }) =>
		(answer.body as { banReasons?: BanReason[] | null }).banReasons;
	const dossierDialog = (answer: { body: unknown }) =>
		(answer.body as { dossier: { banDialog: { reasons: BanReason[]; message: string } | null } })
			.dossier.banDialog;
	const dossierReasons = (answer: { body: unknown }) => dossierDialog(answer)?.reasons ?? null;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
		// rows straight in, as the world makes its own
		const id = `u_bansonly_${w.org.id}`;
		const roleId = `r_bansonly_${w.org.id}`;
		await env.db.insert(orgRoles).values({
			id: roleId,
			orgId: w.org.id,
			name: 'Bans only',
			capabilities: ['server.view', 'bans.manage'],
			sortOrder: 4
		});
		await env.db.insert(user).values({
			id,
			name: id,
			email: `${id}@test.invalid`,
			username: id,
			displayUsername: id,
			role: 'member',
			authComplete: true
		});
		await env.db.insert(orgMembers).values({ orgId: w.org.id, userId: id, role: 'member' });
		await env.db.insert(serverGrants).values({ serverId: w.server.id, userId: id, roleId });
		bansOnly = {
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
	});

	test('an org that never saved a list offers the built-in six', async () => {
		expect(reasonsIn(await state('owner'))).toEqual(DEFAULT_BAN_REASONS);
		expect(reasonsIn(await orgLists('owner'))).toEqual(DEFAULT_BAN_REASONS);
		expect(dossierReasons(await dossier('owner'))).toEqual(DEFAULT_BAN_REASONS);
	});

	test('only an owner of the org changes them, and never through a key', async () => {
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
			const answer = await patch(who, LIST);
			expect({ who, refused: answer.status >= 400 }).toEqual({ who, refused: true });
			expect(await stored()).toBeNull();
		}
		// an owner of one org cannot reach another's
		expect((await patch('owner', LIST, w.otherOrg.id)).status).toBe(404);
		expect(await stored(w.otherOrg.id)).toBeNull();

		const answer = await patch('owner', LIST);
		expect(answer.status).toBe(200);
		expect(reasonsIn(answer)).toEqual(LIST);
		expect(await stored()).toEqual(LIST);
	});

	test('the change is in the audit trail with the list it saved', async () => {
		const [row] = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'list.ban_reasons')))
			.orderBy(desc(auditLog.id))
			.limit(1);
		expect(row).toMatchObject({
			actorId: w.users.owner!.id,
			outcome: 'ok',
			message: 'Quick reasons changed'
		});
		expect((row.detail as { banReasons: BanReason[] }).banReasons).toEqual(LIST);
	});

	test('a list that would not save is refused and changes nothing', async () => {
		for (const bad of [
			'Rule one',
			{ label: 'Rule one', reason: 'not in a list' },
			[...LIST, { label: 'rule ONE', reason: 'a second Rule one', days: null }],
			[...LIST, { label: 'Rule four', reason: '   ', days: null }],
			[{ ...LIST[0], days: 2 }],
			[{ ...LIST[0], days: '7' }],
			many(MAX_BAN_REASONS + 1)
		]) {
			const answer = await patch('owner', bad);
			expect({ bad, status: answer.status }).toEqual({ bad, status: 400 });
			expect(await stored()).toEqual(LIST);
		}
	});

	test('whoever may place a ban reads them, and nobody else', async () => {
		// a server's Bans and Players tabs: Bans on the server, or the org's ban list
		for (const who of ['owner', 'site', 'admin', 'orgBans', 'keyAll', 'keyBans'] as PrincipalName[])
			expect({ who, reasons: reasonsIn(await state(who)) }).toEqual({ who, reasons: LIST });
		for (const who of ['viewer', 'operator', 'orgSlots', 'keyView'] as PrincipalName[])
			expect({ who, reasons: reasonsIn(await state(who)) }).toEqual({ who, reasons: null });
		for (const who of [
			'anon',
			'stranger',
			'outsider',
			'member',
			'elsewhere',
			'keyElsewhere'
		] as PrincipalName[])
			expect({ who, refused: (await state(who)).status >= 400 }).toEqual({ who, refused: true });

		// the org's list pages: whoever edits its ban list
		for (const who of [
			'owner',
			'site',
			'admin',
			'elsewhere',
			'orgBans',
			'keyAll',
			'keyBans'
		] as PrincipalName[])
			expect({ who, reasons: reasonsIn(await orgLists(who)) }).toEqual({ who, reasons: LIST });
		expect(reasonsIn(await orgLists('orgSlots'))).toBeNull();
		for (const who of [
			'anon',
			'stranger',
			'outsider',
			'member',
			'viewer',
			'operator',
			'keyView',
			'keyElsewhere'
		] as PrincipalName[])
			expect({ who, refused: (await orgLists(who)).status >= 400 }).toEqual({ who, refused: true });

		// a dossier, whose ban dialog bans on this server's own list (Bans) or the org's, as the tab
		for (const who of ['owner', 'site', 'admin', 'orgBans', 'keyAll', 'keyBans'] as PrincipalName[])
			expect({ who, reasons: dossierReasons(await dossier(who)) }).toEqual({ who, reasons: LIST });
		for (const who of ['viewer', 'operator', 'orgSlots', 'keyView'] as PrincipalName[])
			expect({ who, reasons: dossierReasons(await dossier(who)) }).toEqual({ who, reasons: null });
		for (const who of [
			'anon',
			'stranger',
			'outsider',
			'member',
			'elsewhere',
			'keyElsewhere'
		] as PrincipalName[])
			expect({ who, refused: (await dossier(who)).status >= 400 }).toEqual({ who, refused: true });
	});

	test('Bans on the server alone reads them there, and opens nothing of the org', async () => {
		// the server's Bans tab bans onto its own list: the buttons and the ban message go with Bans
		const here = await state(bansOnly);
		expect(reasonsIn(here)).toEqual(LIST);
		expect(here.body).toMatchObject({ canEditOrgBans: false, banMessage: '{reason}' });
		expect((await orgLists(bansOnly)).status).toBe(404);
		// and so does the dossier's ban dialog, which bans onto the same list
		expect(dossierDialog(await dossier(bansOnly))).toEqual({ reasons: LIST, message: '{reason}' });
		expect((await patch(bansOnly, [])).status).toBe(403);
		expect(await stored()).toEqual(LIST);
	});

	test("one org's list never reaches another's servers", async () => {
		expect(reasonsIn(await state('outsider', w.otherOrgServer.id))).toEqual(DEFAULT_BAN_REASONS);
	});

	test('an empty list offers none, and null puts back the built-in six', async () => {
		expect((await patch('owner', [])).status).toBe(200);
		expect(await stored()).toEqual([]);
		expect(reasonsIn(await state('orgBans'))).toEqual([]);

		const reset = await patch('owner', null);
		expect(reset.status).toBe(200);
		expect(reasonsIn(reset)).toEqual(DEFAULT_BAN_REASONS);
		expect(await stored()).toBeNull();
		expect(reasonsIn(await state('orgBans'))).toEqual(DEFAULT_BAN_REASONS);
		const [row] = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'list.ban_reasons')))
			.orderBy(desc(auditLog.id))
			.limit(1);
		expect(row).toMatchObject({ message: 'Quick reasons back to the built-in six' });
	});

	test("a suspended org's owners cannot change them", async () => {
		await suspend(env, w.org.id);
		try {
			const answer = await patch('owner', LIST);
			expect(answer.status).toBe(403);
			expect(await stored()).toBeNull();
		} finally {
			await env.db
				.update(organizations)
				.set({ suspendedAt: null, suspendedReason: '' })
				.where(eq(organizations.id, w.org.id));
		}
	});
});
