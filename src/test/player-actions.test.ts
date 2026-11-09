// Kick, Kill and Move are capabilities of their own, split from 'Kick, kill, move'
// (players.moderate) so an owner can let someone move players without letting them kick or kill.
// Each opens its own action and the rules that do the same; a move to the side a player is already
// on is refused, since it would be a kill and nothing else; and migration 0036 gives all three to
// every role and key that held the old one.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { keyUser, type SessionUser } from '$lib/server/access';
import { hashToken, mintToken, principalOf, tokenHint } from '$lib/server/apikeys-core';
import { apiKeys, orgRoles, organizations, servers } from '$lib/server/db/schema';
import { setGateway } from '$lib/server/gateway';
import { localGateway } from '$lib/server/gateway-local';
import { forgetMemory, memoryFor } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { BUILTIN_CAPABILITIES, type Capability } from '$lib/capabilities';
import type { Player } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const PLAYER = '76561198000000611';
const DEFIB = 'Id.Item.Defibrillator.Standard';
/** each capability and the one action it opens */
const ACTION_OF = {
	'players.kick': 'kick',
	'players.kill': 'kill',
	'players.move': 'changeTeam'
} as const satisfies Partial<Record<Capability, string>>;
type PlayerCap = keyof typeof ACTION_OF;
const PLAYER_CAPS = Object.keys(ACTION_OF) as PlayerCap[];

describe.skipIf(!hasTestDb)('Kick, Kill and Move apart', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
	});

	/** the viewer role, holding these besides View */
	const holds = (caps: Capability[]) =>
		env.db
			.update(orgRoles)
			.set({ capabilities: ['server.view', ...caps] })
			.where(eq(orgRoles.id, w.roles.viewer));

	/** a key of the org's carrying these besides View, held to the server under test */
	async function keyWith(caps: Capability[]): Promise<SessionUser> {
		const token = mintToken();
		const [row] = await env.db
			.insert(apiKeys)
			.values({
				id: `k_${token.slice(-12)}`,
				orgId: w.org.id,
				label: caps.join(' '),
				keyHash: hashToken(token),
				hint: tokenHint(token),
				capabilities: ['server.view', ...caps],
				serverIds: [w.server.id]
			})
			.returning();
		return keyUser(principalOf(row));
	}

	const rcon = async (who: SessionUser, action: string, serverId = w.server.id) => {
		const { POST } = await import(join(ROUTES, 'servers/[id]/rcon/[action]', '+server.ts'));
		return callApi(POST, who, {
			method: 'POST',
			params: { id: serverId, action },
			body: { steamId: PLAYER, faction: 'Valkyra', reason: 'test' }
		});
	};

	test('each runs its own action and neither of the others, before the game hears of it', async () => {
		for (const cap of PLAYER_CAPS) {
			await holds([cap]);
			const people: [string, SessionUser][] = [
				['person', w.users.viewer!],
				['key', await keyWith([cap])]
			];
			for (const [who, user] of people)
				for (const [other, action] of Object.entries(ACTION_OF)) {
					const gateway = stubGateway();
					const got = await rcon(user, action);
					const mine = other === cap;
					expect([cap, who, action, got.status, gateway.runs.length]).toEqual([
						cap,
						who,
						action,
						mine ? 200 : 403,
						mine ? 1 : 0
					]);
				}
			// a key held to this server carries nothing to the org's other one
			const gateway = stubGateway();
			const elsewhere = await rcon(people[1][1], ACTION_OF[cap], w.otherServer.id);
			expect([cap, elsewhere.status, gateway.runs.length]).toEqual([cap, 404, 0]);
		}
		// and a refusal names the capability that was missing
		await holds(['players.move']);
		stubGateway();
		expect((await rcon(w.users.viewer!, 'kill')).message).toContain("needs 'Kill'");
	});

	test('a rule that kicks or flags needs Kick, and Team balance needs Move', async () => {
		const params = { id: w.server.id };
		const rules: [string, Record<string, unknown>, PlayerCap][] = [
			['risk_kick', { vacBans: true }, 'players.kick'],
			['name_filter', { characters: 'ascii' }, 'players.kick'],
			['name_filter', { characters: 'ascii', action: 'alert' }, 'players.kick'],
			['ping_kick', { maxPingMs: 250 }, 'players.kick'],
			['team_kill', { kickAt: 3 }, 'players.kick'],
			['kill_rate', { maxKills: 20 }, 'players.kick'],
			['kill_distance', { causes: [DEFIB], action: 'flag' }, 'players.kick'],
			['kill_distance', { causes: [DEFIB], action: 'kick' }, 'players.kick'],
			['name_change', { takenOnly: true }, 'players.kick'],
			['name_change', { action: 'kick' }, 'players.kick'],
			['two_teams', { closedFaction: 'Lonestar' }, 'players.move']
		];
		const routes = ['servers/[id]/triggers', 'servers/[id]/triggers/dry-run'];
		for (const [kind, config, cap] of rules)
			for (const path of routes) {
				const { POST } = await import(join(ROUTES, path, '+server.ts'));
				const save = () =>
					callApi(POST, w.users.viewer!, { method: 'POST', params, body: { kind, config } });
				// the other two together do not stand in for it
				await holds(['automation.manage', ...PLAYER_CAPS.filter((c) => c !== cap)]);
				const refused = await save();
				expect([kind, path, refused.status]).toEqual([kind, path, 403]);
				await holds(['automation.manage', cap]);
				// past the check: whatever the rule's own settings then make of the request
				const allowed = await save();
				expect([kind, path, allowed.status === 403]).toEqual([kind, path, false]);
			}
	});

	describe('a move to the side a player is already on', () => {
		const requests: string[] = [];
		let spy: ReturnType<typeof spyOn>;
		const on = (steamId: string, faction: string): Player => ({
			name: 'P',
			steamId,
			faction,
			kills: 0,
			deaths: 0,
			cash: 0,
			ping: null
		});

		beforeAll(async () => {
			// The worker's own gateway, in this process, with the player list it last read.
			const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
			const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
			memoryFor(server, org).players = [on(PLAYER, 'Lonestar')];
			setGateway(localGateway);
			spy = spyOn(WardogsClient, 'forServer').mockImplementation(
				async () =>
					({
						json: async (method: string, path: string) => {
							requests.push(`${method} ${path}`);
							return { message: 'ok' };
						}
					}) as unknown as WardogsClient
			);
		});

		afterAll(() => {
			spy?.mockRestore();
			forgetMemory(w.server.id);
			stubGateway();
		});

		const move = async (
			who: SessionUser | null,
			steamId: unknown,
			faction: unknown,
			extra: Record<string, unknown> = {}
		) => {
			const { POST } = await import(join(ROUTES, 'servers/[id]/rcon/[action]', '+server.ts'));
			return callApi(POST, who, {
				method: 'POST',
				params: { id: w.server.id, action: 'changeTeam' },
				body: { steamId, faction, ...extra }
			});
		};

		test('is refused, however the side is written, and the game hears nothing', async () => {
			await holds(['players.move']);
			for (const [steamId, faction] of [
				[PLAYER, 'Lonestar'],
				[PLAYER, 'lonestar'],
				[` ${PLAYER} `, ' LONESTAR ']
			]) {
				requests.length = 0;
				const got = await move(w.users.viewer!, steamId, faction);
				expect([faction, got.status, got.code, requests]).toEqual([faction, 409, 'same_side', []]);
				expect(got.message).toBe('That player is already on Lonestar.');
			}
			// holding Kill as well changes nothing: a move is never a kill on its own
			requests.length = 0;
			expect((await move(w.users.owner!, PLAYER, 'Lonestar')).status).toBe(409);
			expect(requests).toEqual([]);
		});

		test('to another side goes, with the kill that respawns them there', async () => {
			await holds(['players.move']);
			requests.length = 0;
			const got = await move(w.users.viewer!, PLAYER, 'Valkyra');
			expect(got.status).toBe(200);
			expect(requests).toEqual([`PATCH /v1/players/${PLAYER}`, `POST /v1/players/${PLAYER}/kill`]);
		});

		test('without the kill, as the Teams view saves, is the move alone, behind the same check', async () => {
			await holds(['players.move']);
			requests.length = 0;
			const got = await move(w.users.viewer!, PLAYER, 'Valkyra', { kill: false });
			expect([got.status, requests]).toEqual([200, [`PATCH /v1/players/${PLAYER}`]]);
			expect((got.body as { result: { message: string } }).result.message).toBe(
				'Moved to Valkyra.'
			);
			// View alone, another org's owner, a key held to the org's other server and nobody signed
			// in are refused before the game hears of it
			await holds([]);
			requests.length = 0;
			const refused: [string, SessionUser | null, number][] = [
				['viewer', w.users.viewer, 403],
				['outsider', w.users.outsider, 404],
				['keyElsewhere', w.users.keyElsewhere, 404],
				['anon', null, 401]
			];
			for (const [who, user, status] of refused)
				expect([who, (await move(user, PLAYER, 'Valkyra', { kill: false })).status]).toEqual([
					who,
					status
				]);
			expect(requests).toEqual([]);
		});

		test('of a player the list does not hold goes to the game, which answers for them', async () => {
			await holds(['players.move']);
			requests.length = 0;
			const other = '76561198000000612';
			expect((await move(w.users.viewer!, other, 'Lonestar')).status).toBe(200);
			expect(requests[0]).toBe(`PATCH /v1/players/${other}`);
		});
	});

	test('migration 0036 gives all three to every role and key that held Kick, kill, move', async () => {
		const m = await seedWorld(env);
		// Rows as they stood before the split: the built-in operator and admin, a custom role, a key
		// over the whole org and one held to a server (these are capabilities on a server, so it
		// keeps them there), and a role and a key that never held it.
		const before = (caps: Capability[]): string[] => [
			...caps.filter((c) => !PLAYER_CAPS.includes(c as PlayerCap)),
			'players.moderate'
		];
		const setRole = (id: string, caps: string[]) =>
			env.db.update(orgRoles).set({ capabilities: caps }).where(eq(orgRoles.id, id));
		const setKey = (id: string, caps: string[]) =>
			env.db.update(apiKeys).set({ capabilities: caps }).where(eq(apiKeys.id, id));
		await setRole(m.roles.operator, before(BUILTIN_CAPABILITIES.operator));
		await setRole(m.roles.admin, before(BUILTIN_CAPABILITIES.admin));
		await setRole(m.roles.orgBans, ['server.view', 'players.moderate', 'lists.ban']);
		await setKey(m.users.keyAll!.apiKey!.id, ['server.view', 'players.moderate']);
		await setKey(m.users.keyElsewhere!.apiKey!.id, [
			'server.view',
			'players.moderate',
			'chat.send'
		]);

		const text = await Bun.file('drizzle/0036_player_action_capabilities.sql').text();
		for (const stmt of text.split('--> statement-breakpoint')) await env.db.execute(sql.raw(stmt));

		const role = async (id: string) =>
			(
				(await env.db.select().from(orgRoles).where(eq(orgRoles.id, id)))[0]
					.capabilities as string[]
			).sort();
		const key = async (id: string) =>
			(
				(await env.db.select().from(apiKeys).where(eq(apiKeys.id, id)))[0].capabilities as string[]
			).sort();
		// the built-ins come out exactly as a new org's
		expect(await role(m.roles.operator)).toEqual([...BUILTIN_CAPABILITIES.operator].sort());
		expect(await role(m.roles.admin)).toEqual([...BUILTIN_CAPABILITIES.admin].sort());
		expect(await role(m.roles.orgBans)).toEqual(
			['server.view', 'lists.ban', ...PLAYER_CAPS].sort()
		);
		expect(await key(m.users.keyAll!.apiKey!.id)).toEqual(['server.view', ...PLAYER_CAPS].sort());
		expect(await key(m.users.keyElsewhere!.apiKey!.id)).toEqual(
			['server.view', 'chat.send', ...PLAYER_CAPS].sort()
		);
		// what never held it is left alone
		expect(await role(m.roles.viewer)).toEqual(['server.view']);
		expect(await role(m.roles.orgSlots)).toEqual(['lists.reserve', 'server.view']);
		expect(await key(m.users.keyView!.apiKey!.id)).toEqual(['server.view']);
		// and nothing that says players.moderate is left anywhere
		const [left] = await env.db.execute<{ n: number }>(sql`
			SELECT (SELECT count(*) FROM org_roles WHERE capabilities ? 'players.moderate')
			     + (SELECT count(*) FROM api_keys WHERE capabilities ? 'players.moderate') AS n`);
		expect(Number(left.n)).toBe(0);
	});
});
