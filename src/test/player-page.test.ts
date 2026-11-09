// The player page (the dossier): every ban that holds a player and who may lift it, what the admin
// actions table shows of each trail row, seed time, and where the player stands with the Seeding
// reward. Each part is read as every kind of reader gets it and held to what that reader may read
// already: a server's Bans tab, the Audit trail, the Automation tab.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { keyUser, type SessionUser } from '$lib/server/access';
import { hashToken, mintToken, principalOf, tokenHint } from '$lib/server/apikeys-core';
import { writeAudit } from '$lib/server/audit';
import { ensureOrgLists, ensureServerLists, listOf, serverListOf } from '$lib/server/lists';
import { actionParts } from '$lib/server/players';
import {
	apiKeys,
	listEntries,
	orgMembers,
	orgRoles,
	playerSessions,
	serverBans,
	serverGrants,
	serverReserved,
	triggers,
	user
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import type { DossierView, PlayerBanView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const PLAYER = '76561198000000501';
const DAY = 86400_000;

describe('what the admin actions table takes from a trail row', () => {
	test("a hand-sent kick's or ban's reason, a whisper's text, nothing else of the detail", () => {
		const extra = { note: 'never shown', password: 'x' };
		expect(
			actionParts('rcon.kick', { steamId: PLAYER, reason: 'Spawn camping', ...extra })
		).toEqual({ reason: 'Spawn camping', text: '', list: null, length: null });
		expect(actionParts('rcon.ban', { reason: 'Cheating' }).reason).toBe('Cheating');
		expect(actionParts('rcon.whisper', { message: 'Stop that', reason: 'not this' })).toEqual({
			reason: '',
			text: 'Stop that',
			list: null,
			length: null
		});
		// a reason or a text is only read where the action has one
		expect(actionParts('rcon.kill', { reason: 'r', message: 'm' })).toEqual({
			reason: '',
			text: '',
			list: null,
			length: null
		});
		expect(actionParts('rcon.kick', { reason: 42 }).reason).toBe('');
		expect(actionParts('rcon.kick', null).reason).toBe('');
		expect(actionParts('rcon.kick', { reason: 'r'.repeat(300) }).reason).toHaveLength(200);
		expect(actionParts('rcon.whisper', { message: 'm'.repeat(300) }).text).toHaveLength(256);
	});

	test('a list row says which list, and how long an entry added or changed lasts', () => {
		const until = new Date(Date.now() + 5 * DAY).toISOString();
		expect(actionParts('list.add', { kind: 'ban', reason: 'r', expiresAt: until })).toEqual({
			reason: 'r',
			text: '',
			list: 'ban',
			length: { until }
		});
		expect(actionParts('list.add', { kind: 'reserve', expiresAt: null }).length).toEqual({
			until: null
		});
		// a change that left the length alone says nothing of it, and a removal has none
		expect(actionParts('list.update', { kind: 'ban', reason: 'r' }).length).toBeNull();
		expect(actionParts('list.remove', { kind: 'ban', expiresAt: until }).length).toBeNull();
		expect(actionParts('list.add', { kind: 'other', expiresAt: until })).toEqual({
			reason: '',
			text: '',
			list: null,
			length: null
		});
		expect(actionParts('list.add', { kind: 'ban', expiresAt: 5 }).length).toBeNull();
	});
});

describe.skipIf(!hasTestDb)('the player page', () => {
	let env: Env;
	let w: World;
	const OWN_UNTIL = new Date(Date.now() + 3 * DAY);
	const SLOT_UNTIL = new Date(Date.now() + 2 * DAY);
	let label: Map<string, string>;
	/** beside the world's cast: Bans on one alone (a member, and a key held to one), and a key held
	 *  to one with Automation alone */
	type Reader = PrincipalName | 'bansOnly' | 'keyBansOne' | 'keyAutoOne';
	const extra: Partial<Record<Reader, SessionUser>> = {};
	const as = (who: Reader) => extra[who] ?? w.users[who as PrincipalName];

	/** Where each reader opens the page: a server they can open. */
	const homeOf = (who: Reader) =>
		who === 'elsewhere' || who === 'keyElsewhere' ? w.otherServer.id : w.server.id;
	const READERS: Reader[] = [
		'viewer',
		'operator',
		'admin',
		'elsewhere',
		'orgBans',
		'orgSlots',
		'owner',
		'site',
		'keyView',
		'keyAll',
		'keyElsewhere',
		'keyBans',
		'bansOnly',
		'keyBansOne',
		'keyAutoOne'
	];

	const dossierOf = async (who: Reader, serverId = homeOf(who), steamId = PLAYER) => {
		const { GET } = await import(join(ROUTES, 'api/servers/[id]/players/[steamId]', '+server.ts'));
		return callApi(GET, as(who), { params: { id: serverId, steamId } });
	};
	const read = async (who: Reader, steamId = PLAYER): Promise<DossierView> => {
		const answer = await dossierOf(who, homeOf(who), steamId);
		expect({ who, status: answer.status }).toEqual({ who, status: 200 });
		return (answer.body as { dossier: DossierView }).dossier;
	};
	const stateOf = async (who: Reader, serverId: string) => {
		const { GET } = await import(join(ROUTES, 'api/servers/[id]/lists/state', '+server.ts'));
		const answer = await callApi(GET, as(who), { params: { id: serverId } });
		expect({ who, serverId, status: answer.status }).toEqual({ who, serverId, status: 200 });
		return answer.body as {
			bans: Record<string, { reason: string; addedByName: string; scope: string }>;
			banReasons: unknown;
			banMessage: string | null;
		};
	};
	const line = (b: PlayerBanView) =>
		[
			b.serverId ? `${b.source}@${label.get(b.serverId)}` : b.source,
			b.reason,
			`by:${b.by}`,
			b.canUnban ? 'unban' : ''
		]
			.filter(Boolean)
			.join(' ');

	/** The bans the page lists, put back as they were: the org's list, two's own, one's game list. */
	async function seedBans() {
		const now = new Date();
		const orgBans = await listOf(env, w.org.id, 'ban');
		const twoBans = await serverListOf(env, { id: w.otherServer.id, orgId: w.org.id }, 'ban');
		const oneBans = await serverListOf(env, { id: w.server.id, orgId: w.org.id }, 'ban');
		const theirBans = await listOf(env, w.otherOrg.id, 'ban');
		await env.db
			.update(listEntries)
			.set({ removedAt: now, removal: 'manual' })
			.where(
				and(
					eq(listEntries.steamId, PLAYER),
					isNull(listEntries.removedAt),
					inArray(listEntries.listId, [orgBans.id, twoBans.id, oneBans.id, theirBans.id])
				)
			);
		const entry = (listId: string, reason: string, by: string, expiresAt: Date | null) => ({
			id: newId(),
			listId,
			steamId: PLAYER,
			reason,
			addedByName: by,
			expiresAt
		});
		await env.db.insert(listEntries).values([
			entry(orgBans.id, 'org-wide reason', 'orgAuthor', null),
			entry(twoBans.id, 'reason on two', 'ownAuthor', OWN_UNTIL),
			// lapsed, though the sweep has not stamped it yet: not in force
			entry(oneBans.id, 'lapsed reason', 'ownAuthor', new Date(now.getTime() - DAY)),
			entry(theirBans.id, 'other org reason', 'theirAuthor', null)
		]);
		await env.db.insert(listEntries).values({
			...entry(oneBans.id, 'withdrawn reason', 'ownAuthor', null),
			removedAt: now,
			removal: 'manual'
		});
		for (const [serverId, reason] of [
			[w.server.id, 'game reason'],
			[w.otherOrgServer.id, 'other org game reason']
		])
			await env.db
				.insert(serverBans)
				.values({ serverId, steamId: PLAYER, reason, bannedBy: 'config' })
				.onConflictDoNothing();
	}

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
		label = new Map([
			[w.server.id, 'one'],
			[w.otherServer.id, 'two'],
			[w.otherOrgServer.id, 'theirs']
		]);
		// every server takes its org's lists and its own, as createServer leaves it
		for (const [orgId, serverIds] of [
			[w.org.id, [w.server.id, w.otherServer.id]],
			[w.otherOrg.id, [w.otherOrgServer.id]]
		] as const) {
			await ensureOrgLists(env.db, orgId);
			for (const id of serverIds) await ensureServerLists(env.db, id, orgId);
		}
		await seedBans();

		// a member whose role on one holds Bans and nothing of the org's lists
		const uid = `u_bansonly_${newId().slice(0, 8)}`;
		await env.db.insert(user).values({
			id: uid,
			name: uid,
			email: `${uid}@test.invalid`,
			username: uid,
			displayUsername: uid,
			role: 'member',
			authComplete: true
		});
		const roleId = `r_bansonly_${newId().slice(0, 8)}`;
		await env.db.insert(orgRoles).values({
			id: roleId,
			orgId: w.org.id,
			name: 'Bans only',
			capabilities: ['server.view', 'bans.manage'],
			sortOrder: 4
		});
		await env.db.insert(orgMembers).values({ orgId: w.org.id, userId: uid, role: 'member' });
		await env.db.insert(serverGrants).values({ serverId: w.server.id, userId: uid, roleId });
		extra.bansOnly = { ...w.users.viewer!, id: uid, username: uid, name: uid };
		const key = async (label: string, capabilities: string[]) => {
			const token = mintToken();
			const [row] = await env.db
				.insert(apiKeys)
				.values({
					id: `k_${label}_${newId().slice(0, 8)}`,
					orgId: w.org.id,
					label,
					keyHash: hashToken(token),
					hint: tokenHint(token),
					capabilities: capabilities as never,
					serverIds: [w.server.id]
				})
				.returning();
			return keyUser(principalOf(row));
		};
		extra.keyBansOne = await key('bans one', ['server.view', 'bans.manage']);
		extra.keyAutoOne = await key('automation one', ['server.view', 'automation.manage']);

		const ago = (ms: number) => new Date(Date.now() - ms);
		const session = (serverId: string, joined: number, left: number | null, seed: number) => ({
			serverId,
			steamId: PLAYER,
			name: 'Player',
			joinedAt: ago(joined),
			lastSeen: ago(left ?? 0),
			leftAt: left === null ? null : ago(left),
			seedSeconds: seed
		});
		await env.db.insert(playerSessions).values([
			session(w.server.id, 2 * DAY + 3600_000, 2 * DAY, 1200),
			// before the reward's window: counts in the totals, not toward the reward
			session(w.server.id, 10 * DAY + 3600_000, 10 * DAY, 6000),
			// still on
			session(w.server.id, 3600_000, null, 300),
			session(w.otherServer.id, DAY + 3600_000, DAY, 900),
			session(w.otherOrgServer.id, DAY + 3600_000, DAY, 5000)
		]);

		await env.db.insert(triggers).values({
			id: newId(),
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'seed_reward',
			name: 'Seeding reward',
			enabled: true,
			config: {
				scope: 'server',
				lowAt: 20,
				untilFull: true,
				fullAt: null,
				minutes: 60,
				windowDays: 7,
				slotDays: 7,
				message: ''
			}
		});
		const oneSlots = await serverListOf(env, { id: w.server.id, orgId: w.org.id }, 'reserve');
		await env.db.insert(listEntries).values({
			id: newId(),
			listId: oneSlots.id,
			steamId: PLAYER,
			reason: 'seeded',
			addedByName: 'rule',
			expiresAt: SLOT_UNTIL
		});
		await env.db.insert(serverReserved).values({ serverId: w.server.id, steamId: PLAYER });

		const at = (who: PrincipalName) => {
			const u = w.users[who]!;
			return { id: u.id, username: u.username };
		};
		const server = (id: string) => ({ id, name: label.get(id)! });
		const rows = [
			{
				actor: at('admin'),
				server: server(w.server.id),
				orgId: w.org.id,
				category: 'rcon' as const,
				action: 'rcon.kick',
				detail: { steamId: PLAYER, reason: 'kick reason', note: 'never shown' },
				message: 'Kicked Player.'
			},
			{
				actor: at('operator'),
				server: server(w.server.id),
				orgId: w.org.id,
				category: 'rcon' as const,
				action: 'rcon.whisper',
				detail: { steamId: PLAYER, message: 'whisper text', note: 'never shown' },
				message: 'Message sent to Player.'
			},
			{
				actor: at('viewer'),
				server: server(w.server.id),
				orgId: w.org.id,
				category: 'rcon' as const,
				action: 'rcon.whisper',
				detail: { steamId: PLAYER, message: 'denied whisper' },
				outcome: 'denied' as const,
				message: "Needs 'chat.send'"
			},
			{
				actor: at('elsewhere'),
				server: server(w.otherServer.id),
				orgId: w.org.id,
				category: 'server' as const,
				action: 'list.add',
				detail: {
					kind: 'ban',
					listId: 'x',
					reason: 'reason on two',
					expiresAt: OWN_UNTIL.toISOString()
				},
				message: 'Banned on two: reason on two'
			},
			{
				actor: at('owner'),
				orgId: w.org.id,
				category: 'org' as const,
				action: 'list.add',
				detail: { kind: 'ban', listId: 'y', reason: 'org-wide reason', expiresAt: null },
				message: 'Banned across the org: org-wide reason'
			},
			{
				actor: at('outsider'),
				server: server(w.otherOrgServer.id),
				orgId: w.otherOrg.id,
				category: 'rcon' as const,
				action: 'rcon.whisper',
				detail: { steamId: PLAYER, message: 'other org whisper' },
				message: 'Message sent to Player.'
			}
		];
		for (const r of rows)
			await writeAudit(env, null, { ...r, target: PLAYER, outcome: r.outcome ?? 'ok' });
	});

	test('nobody outside the server sees the page, and another org never shows in it', async () => {
		for (const [who, status] of [
			['anon', 401],
			['stranger', 404],
			['outsider', 404],
			['member', 404]
		] as const)
			expect({ who, status: (await dossierOf(who)).status }).toEqual({ who, status });
		// a reader of one server cannot open the page through a server they cannot open
		expect((await dossierOf('elsewhere', w.server.id)).status).toBe(404);
		expect((await dossierOf('keyElsewhere', w.server.id)).status).toBe(404);
		for (const who of ['bansOnly', 'keyBansOne', 'keyAutoOne'] as const)
			expect({ who, status: (await dossierOf(who, w.otherServer.id)).status }).toEqual({
				who,
				status: 404
			});
		expect((await dossierOf('viewer', w.otherOrgServer.id)).status).toBe(404);
		for (const who of READERS) {
			const text = JSON.stringify(await read(who));
			for (const theirs of ['other org reason', 'other org game reason', 'other org whisper'])
				expect({ who, leaks: text.includes(theirs) }).toEqual({ who, leaks: false });
		}
	});

	test('every ban in force shows, panel bans included, with who may lift it', async () => {
		const ORG = (by: string, unban: boolean) =>
			`org org-wide reason by:${by}${unban ? ' unban' : ''}`;
		const GAME = (unban: boolean) => `game@one game reason by:config${unban ? ' unban' : ''}`;
		const OWN = (by: string, unban: boolean) =>
			`server@two reason on two by:${by}${unban ? ' unban' : ''}`;
		const expected: Partial<Record<Reader, string[]>> = {
			viewer: [ORG('', false), GAME(false)],
			operator: [ORG('', false), GAME(false)],
			admin: [ORG('orgAuthor', true), GAME(true)],
			orgBans: [ORG('orgAuthor', true), GAME(false)],
			orgSlots: [ORG('', false), GAME(false)],
			// Bans on two and the org list (an admin there): two's own entry, its author, both lifts
			elsewhere: [ORG('orgAuthor', true), OWN('ownAuthor', true)],
			// a key held to two alone cannot touch the org's list, whatever it carries
			keyElsewhere: [ORG('orgAuthor', false), OWN('ownAuthor', true)],
			owner: [ORG('orgAuthor', true), GAME(true), OWN('ownAuthor', true)],
			site: [ORG('orgAuthor', true), GAME(true), OWN('ownAuthor', true)],
			keyView: [ORG('', false), GAME(false), OWN('', false)],
			keyAll: [ORG('orgAuthor', true), GAME(true), OWN('ownAuthor', true)],
			// the org's ban list without Bans: authors read, the org's list lifted, nothing else
			keyBans: [ORG('orgAuthor', true), GAME(false), OWN('ownAuthor', false)],
			// Bans on one alone: the org ban's author (one's Bans tab shows it), one's game ban lifted
			bansOnly: [ORG('orgAuthor', false), GAME(true)],
			keyBansOne: [ORG('orgAuthor', false), GAME(true)],
			keyAutoOne: [ORG('', false), GAME(false)]
		};
		for (const who of READERS) {
			const bans = (await read(who)).bans;
			expect({ who, bans: bans.map(line) as string[] | undefined }).toEqual({
				who,
				bans: expected[who]
			});
			const own = bans.find((b) => b.source === 'server');
			if (own) expect(own.expiresAt).toBe(OWN_UNTIL.toISOString());
			expect(bans.find((b) => b.source === 'org')?.expiresAt).toBeNull();
		}
	});

	test('what a ban says matches the Bans tab of each server the reader can open', async () => {
		for (const who of READERS) {
			const org = (await read(who)).bans.find((b) => b.source === 'org')!;
			const tabs = await Promise.all(
				[w.server.id, w.otherServer.id]
					.filter(
						(id) =>
							id === homeOf(who) || ['owner', 'site', 'keyView', 'keyAll', 'keyBans'].includes(who)
					)
					.map((id) => stateOf(who, id))
			);
			for (const tab of tabs)
				expect({ who, reason: tab.bans[PLAYER].reason }).toEqual({ who, reason: org.reason });
			// who placed it shows here only where some Bans tab of theirs shows it
			expect({ who, by: org.by !== '' }).toEqual({
				who,
				by: tabs.some((t) => t.bans[PLAYER].addedByName !== '')
			});
		}
	});

	test('the admin actions table holds the trail rows the reader may read, and no more of them', async () => {
		const { GET: trail } = await import(join(ROUTES, 'api/audit', '+server.ts'));
		const shown: Record<string, string[]> = {};
		for (const who of READERS) {
			const d = await read(who);
			const text = JSON.stringify(d.actions);
			expect({ who, detail: text.includes('never shown') || text.includes('"detail"') }).toEqual({
				who,
				detail: false
			});
			const answer = await callApi(trail, as(who), { query: `q=${PLAYER}&limit=500` });
			const theirs = (
				answer.body as {
					entries: {
						id: number;
						target: string;
						orgId: string | null;
						action: string;
						detail: unknown;
					}[];
				}
			).entries.filter((e) => e.target === PLAYER && e.orgId === w.org.id);
			expect({ who, ids: d.actions.map((a) => a.id).sort() }).toEqual({
				who,
				ids: theirs.map((e) => e.id).sort()
			});
			for (const a of d.actions) {
				const row = theirs.find((e) => e.id === a.id)!;
				const { reason, text: said, list, length } = a;
				expect({ who, id: a.id, reason, said, list, length }).toEqual({
					who,
					id: a.id,
					...(({ reason, text, list, length }) => ({ reason, said: text, list, length }))(
						actionParts(row.action, row.detail)
					)
				});
			}
			shown[who] = d.actions
				.map((a) =>
					[a.reason, a.text, a.list && `${a.list} ${a.length?.until ?? 'for good'}`]
						.filter(Boolean)
						.join(' | ')
				)
				.sort();
		}
		const two = `reason on two | ban ${OWN_UNTIL.toISOString()}`;
		expect(shown.viewer).toEqual(['denied whisper']);
		expect(shown.operator).toEqual(['whisper text']);
		expect(shown.admin).toEqual(['denied whisper', 'kick reason', 'whisper text']);
		expect(shown.elsewhere).toEqual([two]);
		expect(shown.keyView).toEqual([]);
		for (const who of ['bansOnly', 'keyBansOne', 'keyAutoOne']) expect(shown[who]).toEqual([]);
		expect(shown.keyAll).toEqual(['denied whisper', 'kick reason', two, 'whisper text']);
		expect(shown.owner).toEqual([
			'denied whisper',
			'kick reason',
			'org-wide reason | ban for good',
			two,
			'whisper text'
		]);
	});

	test('seed time adds up over the servers the reader can open', async () => {
		const owner = await read('owner');
		expect(owner.summary.seedMinutes).toBe((1200 + 6000 + 300 + 900) / 60);
		expect(
			Object.fromEntries(owner.perServer.map((s) => [label.get(s.serverId), s.seedMinutes]))
		).toEqual({ one: (1200 + 6000 + 300) / 60, two: 15 });
		const viewer = await read('viewer');
		expect(viewer.summary.seedMinutes).toBe((1200 + 6000 + 300) / 60);
		expect(viewer.perServer.map((s) => label.get(s.serverId))).toEqual(['one']);
		expect((await read('elsewhere')).summary.seedMinutes).toBe(15);
	});

	test("the Seeding reward's terms and a player's progress are for Automation holders", async () => {
		const progress = {
			minutes: 60,
			windowDays: 7,
			lowAt: 20,
			untilFull: true,
			slotDays: 7,
			scope: 'server' as const,
			// the window's closed sessions and the one still open, on this server alone
			seconds: 1200 + 300,
			holdsSlot: { until: SLOT_UNTIL.toISOString() }
		};
		for (const who of READERS) {
			const seen = (await read(who)).seedReward;
			// two has no rule, so its readers have nothing to see either way
			const automation = ['admin', 'owner', 'site', 'keyAll', 'keyAutoOne'].includes(who);
			expect({ who, seen }).toEqual({ who, seen: automation ? progress : null });
		}

		// a slot only the game holds has no end the panel knows; without one the rule may grant
		await env.db
			.update(listEntries)
			.set({ removedAt: new Date(), removal: 'manual' })
			.where(and(eq(listEntries.steamId, PLAYER), eq(listEntries.reason, 'seeded')));
		expect((await read('owner')).seedReward?.holdsSlot).toEqual({ until: null });
		await env.db.delete(serverReserved).where(eq(serverReserved.steamId, PLAYER));
		expect((await read('owner')).seedReward?.holdsSlot).toBeNull();

		await env.db.update(triggers).set({ enabled: false }).where(eq(triggers.serverId, w.server.id));
		expect((await read('owner')).seedReward).toBeNull();
		await env.db.update(triggers).set({ enabled: true }).where(eq(triggers.serverId, w.server.id));
	});

	test("the ban dialog's reasons and message reach whoever the Bans tab gives them", async () => {
		const staff: string[] = [];
		for (const who of READERS) {
			const d = await read(who);
			const tab = await stateOf(who, homeOf(who));
			const want =
				tab.banReasons === null ? null : { reasons: tab.banReasons, message: tab.banMessage };
			expect({ who, dialog: d.banDialog as unknown }).toEqual({ who, dialog: want });
			if (d.banDialog) staff.push(who);
		}
		expect(staff.sort()).toEqual(
			[
				'admin',
				'bansOnly',
				'elsewhere',
				'keyAll',
				'keyBans',
				'keyBansOne',
				'keyElsewhere',
				'orgBans',
				'owner',
				'site'
			].sort()
		);
	});

	test('the page load answers what the API does', async () => {
		const { load } = await import(
			join(ROUTES, '(app)/server/[id]/players/[steamId]', '+page.server.ts')
		);
		for (const who of ['viewer', 'owner'] as const) {
			const page = await callLoad(load, w.users[who], {
				params: { id: w.server.id, steamId: PLAYER }
			});
			const fromPage = (page.body as { dossier: DossierView }).dossier;
			const fromApi = await read(who);
			expect({ who, bans: fromPage.bans, reward: fromPage.seedReward }).toEqual({
				who,
				bans: fromApi.bans,
				reward: fromApi.seedReward
			});
		}
	});
	test('the real writers: a ban on a server list, a kick and a whisper read back as written', async () => {
		const SECOND = '76561198000000502';
		const { POST: addOwn } = await import(
			join(ROUTES, 'api/servers/[id]/lists/ban/entries', '+server.ts')
		);
		const { POST: rcon } = await import(
			join(ROUTES, 'api/servers/[id]/rcon/[action]', '+server.ts')
		);
		const admin = w.users.admin!;
		const until = new Date(Date.now() + 2 * DAY);
		until.setMilliseconds(0);
		const banned = await callApi(addOwn, admin, {
			method: 'POST',
			params: { id: w.server.id },
			body: { steamId: SECOND, reason: 'real ban', expiresAt: until.toISOString() }
		});
		expect(banned.status).toBe(201);
		for (const [action, body] of [
			['kick', { steamId: SECOND, reason: 'real kick' }],
			['whisper', { steamId: SECOND, message: 'real whisper' }]
		] as const) {
			const sent = await callApi(rcon, admin, {
				method: 'POST',
				params: { id: w.server.id, action },
				body
			});
			expect({ action, status: sent.status }).toEqual({ action, status: 200 });
		}
		const d = await read('admin', SECOND);
		expect(
			d.actions.map(({ action, reason, text, list, length }) => ({
				action,
				reason,
				text,
				list,
				length
			}))
		).toEqual([
			{ action: 'rcon.whisper', reason: '', text: 'real whisper', list: null, length: null },
			{ action: 'rcon.kick', reason: 'real kick', text: '', list: null, length: null },
			{
				action: 'list.add',
				reason: 'real ban',
				text: '',
				list: 'ban',
				length: { until: until.toISOString() }
			}
		]);
		expect(d.bans.map(line)).toEqual([`server@one real ban by:${admin.username} unban`]);
		expect(d.bans[0].expiresAt).toBe(until.toISOString());
		// a viewer of one reads the ban and when it lifts, not who placed it, and none of the trail
		const v = await read('viewer', SECOND);
		expect(v.bans.map(line)).toEqual(['server@one real ban by:']);
		expect(v.actions).toEqual([]);
	});

	// Last: lifting bans writes trail rows and the bans are put back after each.
	test('each Unban the page offers is one its route allows, and the rest are refused', async () => {
		const { DELETE: orgDelete } = await import(
			join(ROUTES, 'api/orgs/[id]/lists/[kind]/entries/[steamId]', '+server.ts')
		);
		const { DELETE: ownDelete } = await import(
			join(ROUTES, 'api/servers/[id]/lists/ban/entries/[steamId]', '+server.ts')
		);
		const { POST: rcon } = await import(
			join(ROUTES, 'api/servers/[id]/rcon/[action]', '+server.ts')
		);
		for (const who of READERS) {
			const bans = (await read(who)).bans;
			for (const b of bans) {
				const caller = as(who);
				const answer =
					b.source === 'org'
						? await callApi(orgDelete, caller, {
								method: 'DELETE',
								params: { id: w.org.id, kind: 'ban', steamId: PLAYER }
							})
						: b.source === 'server'
							? await callApi(ownDelete, caller, {
									method: 'DELETE',
									params: { id: b.serverId!, steamId: PLAYER }
								})
							: await callApi(rcon, caller, {
									method: 'POST',
									params: { id: b.serverId!, action: 'unban' },
									body: { steamId: PLAYER }
								});
				const lifted = answer.status === 200;
				expect({ who, ban: line(b), lifted }).toEqual({ who, ban: line(b), lifted: b.canUnban });
				if (!lifted) expect([403, 404]).toContain(answer.status);
				await seedBans();
			}
		}
	});
});
