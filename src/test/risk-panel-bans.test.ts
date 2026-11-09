// Bans placed through the panel count toward risk again: since 9887c93 they never reach the game's
// own lists, which were all the risk score and Kick on connect risk read. A risk kick still says
// no more than that the player is banned elsewhere: never where, why, or whom they resemble.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { getServer, type ServerRow } from '$lib/server/access';
import { ensureOrgLists, ensureServerLists, listOf, serverListOf } from '$lib/server/lists';
import { riskKickVerdict, type RiskKickConfig } from '$lib/server/trigger-rules';
import { riskInputs } from '$lib/server/triggers';
import { listEntries, playerSessions, serverBans } from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import type { DossierView, PlayerMark } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
/** banned on two's own list */
const JOINER = '76561198000000601';
/** banned on the org's list */
const ORG_BANNED = '76561198000000602';
/** on two's own list, lapsed */
const LAPSED = '76561198000000603';
/** banned on two's own list, last seen there as Wolfhound */
const BANNED_NAMED = '76561198000000604';
/** joins as a name like Wolfhound's */
const LOOKALIKE = '76561198000000605';
/** banned on every list of another organisation, last seen there as Ravensong */
const THEIRS = '76561198000000606';

const CFG: RiskKickConfig = {
	vacBans: false,
	gameBans: false,
	maxBanAgeDays: 0,
	minAccountDays: 0,
	privateProfiles: false,
	bannedElsewhere: true,
	watchlist: false,
	kickAtScore: null,
	spareReserved: true,
	reason: 'Not allowed here.'
};

describe.skipIf(!hasTestDb)('panel bans and risk', () => {
	let env: Env;
	let w: World;
	let one: ServerRow;
	let two: ServerRow;
	const player = (steamId: string, name = 'Player') => ({
		steamId,
		name,
		faction: null,
		kills: 0
	});
	const joins = async (server: ServerRow, p: ReturnType<typeof player>, withScore = false) => {
		const { signals } = await riskInputs(env, server, [p as never], withScore);
		return signals.get(p.steamId)!;
	};
	const verdict = (cfg: RiskKickConfig, s: Awaited<ReturnType<typeof joins>>) =>
		riskKickVerdict(cfg, {
			profile: null,
			steamEnabled: false,
			bannedOn: s.bannedOn,
			watched: null,
			resembles: s.resembles,
			reserved: false,
			now: new Date()
		});
	const riskOf = async (who: PrincipalName, steamId: string, serverId = w.server.id) => {
		const { GET } = await import(join(ROUTES, 'servers/[id]/players/[steamId]', '+server.ts'));
		const answer = await callApi(GET, w.users[who], { params: { id: serverId, steamId } });
		expect({ who, status: answer.status }).toEqual({ who, status: 200 });
		return (answer.body as { dossier: DossierView }).dossier.risk.reasons.map((r) => r.text);
	};

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
		await ensureOrgLists(env.db, w.org.id);
		for (const id of [w.server.id, w.otherServer.id]) await ensureServerLists(env.db, id, w.org.id);
		one = (await getServer(env, w.server.id))!;
		two = (await getServer(env, w.otherServer.id))!;
		const twoBans = await serverListOf(env, two, 'ban');
		const orgBans = await listOf(env, w.org.id, 'ban');
		const entry = (
			listId: string,
			steamId: string,
			reason: string,
			expiresAt: Date | null = null
		) => ({
			id: newId(),
			listId,
			steamId,
			reason,
			addedByName: 'someone',
			expiresAt
		});
		await env.db
			.insert(listEntries)
			.values([
				entry(twoBans.id, JOINER, 'reason on two'),
				entry(orgBans.id, ORG_BANNED, 'org reason'),
				entry(twoBans.id, LAPSED, 'lapsed reason', new Date(Date.now() - 60_000)),
				entry(twoBans.id, BANNED_NAMED, 'griefing')
			]);
		const t = new Date(Date.now() - 3600_000);
		await env.db.insert(playerSessions).values({
			serverId: two.id,
			steamId: BANNED_NAMED,
			name: 'Wolfhound',
			joinedAt: t,
			lastSeen: t,
			leftAt: t
		});
	});

	test("a ban on another server's own list counts when the player joins this one", async () => {
		const s = await joins(one, player(JOINER));
		expect(s.bannedOn).toEqual([
			{
				steamId: JOINER,
				serverId: two.id,
				serverName: two.name,
				reason: 'reason on two',
				bannedBy: ''
			}
		]);
		expect(verdict(CFG, s)).toBe('banned on another server of this organisation');
	});

	test('a ban that holds the player where they join is enforced there, not a sign from elsewhere', async () => {
		// two's own list, joining two; the org's list holds them on one as on every server
		expect((await joins(two, player(JOINER))).bannedOn).toEqual([]);
		expect((await joins(one, player(ORG_BANNED))).bannedOn).toEqual([]);
		expect((await joins(one, player(LAPSED))).bannedOn).toEqual([]);
	});

	test('a lookalike of a panel-banned player counts toward a score, and the kick names neither', async () => {
		const s = await joins(one, player(LOOKALIKE, 'Wolfhound2'), true);
		expect(s.resembles).toEqual([
			{ name: 'Wolfhound', steamId: BANNED_NAMED, serverName: two.name }
		]);
		const v = verdict({ ...CFG, bannedElsewhere: false, kickAtScore: 20 }, s);
		expect(v).toBe('medium risk (20): Name resembles a banned player [Steam not checked]');
	});

	test("another organisation's bans never count, nor its banned players' names", async () => {
		await ensureOrgLists(env.db, w.otherOrg.id);
		await ensureServerLists(env.db, w.otherOrgServer.id, w.otherOrg.id);
		const theirOrg = await listOf(env, w.otherOrg.id, 'ban');
		const theirOwn = await serverListOf(
			env,
			{ id: w.otherOrgServer.id, orgId: w.otherOrg.id },
			'ban'
		);
		await env.db.insert(listEntries).values(
			[theirOrg.id, theirOwn.id].map((listId) => ({
				id: newId(),
				listId,
				steamId: THEIRS,
				reason: 'their reason',
				addedByName: 'them'
			}))
		);
		await env.db
			.insert(serverBans)
			.values({ serverId: w.otherOrgServer.id, steamId: THEIRS, reason: 'their game ban' });
		const t = new Date(Date.now() - 3600_000);
		await env.db.insert(playerSessions).values({
			serverId: w.otherOrgServer.id,
			steamId: THEIRS,
			name: 'Ravensong',
			joinedAt: t,
			lastSeen: t,
			leftAt: t
		});
		const s = await joins(one, player(THEIRS), true);
		expect(s.bannedOn).toEqual([]);
		expect(verdict(CFG, s)).toBeNull();
		expect((await joins(one, player(LOOKALIKE, 'Ravensong2'), true)).resembles).toEqual([]);
	});

	test('the player page and the players table count panel bans only on servers the reader can open', async () => {
		expect(await riskOf('owner', JOINER)).toContain(`Banned on ${two.name}: reason on two`);
		expect(await riskOf('elsewhere', JOINER, two.id)).toContain(
			`Banned on ${two.name}: reason on two`
		);
		// viewer and admin of one alone: two is not theirs to read
		for (const who of ['viewer', 'admin'] as const) {
			const reasons = await riskOf(who, JOINER);
			expect({ who, leaks: reasons.some((r) => r.includes('reason on two')) }).toEqual({
				who,
				leaks: false
			});
		}
		// the org's list holds the player on every server, so every reader of one may read it
		expect(await riskOf('viewer', ORG_BANNED)).toContain(
			'Banned on every server of the organisation: org reason'
		);

		const { GET } = await import(join(ROUTES, 'servers/[id]/players/marks', '+server.ts'));
		const marks = async (who: PrincipalName) => {
			const answer = await callApi(GET, w.users[who], {
				params: { id: w.server.id },
				query: `ids=${JOINER}&names=Joiner`
			});
			expect({ who, status: answer.status }).toEqual({ who, status: 200 });
			return JSON.stringify((answer.body as { marks: PlayerMark[] }).marks);
		};
		expect(await marks('owner')).toContain('reason on two');
		expect(await marks('viewer')).not.toContain('reason on two');
		expect(await marks('admin')).not.toContain('reason on two');
	});
});
