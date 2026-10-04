// What happens in the worker once the kill feed has written a batch: the kills go out on the
// event bus (the SSE route fans them to browsers; in the split roles every web process gets them
// through the relay stream), and the team-kill rules get their turn. Their intents go through
// the same outbox as every other trigger, so delivery, audit and the Discord mirror are shared.
// The Kill rate and Kill distance rules see every batch; the rest of the work is for batches with
// team kills.
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Env } from './env';
import { emit } from './events';
import { kills, matches } from './db/schema';
import { killsOfMatch } from './matches';
import {
	enabledTriggers,
	killDistanceAct,
	renderTemplate,
	statsFor,
	statsOf,
	statsReader,
	teamKillStage,
	type Evaluation,
	type StatsRead
} from './triggers';
import { messageVars, serverVars, type MessageVars } from './message-vars';
import { mapName } from '$lib/format';
import { countsForTeamKill, MAX_REASON, type TeamKillConfig } from './trigger-rules';
import { MAX_CHAT } from '$lib/chat';
import {
	countsForRate,
	KILL_RATE_FLAG,
	killRateStep,
	killTimes,
	pruneTracks,
	type KillRateConfig,
	type RateTrack,
	type RateTracks
} from './kill-rate';
import {
	countsForDistance,
	killDistanceSettingsKey,
	killDistanceStep,
	matchKey,
	type DistanceTrack,
	type DistanceTracks,
	type KillDistanceConfig
} from './kill-distance';
import { applyTriggerUpdates, enqueueIntents, wakeDelivery } from './outbox';
import { LostOwnership, withOwnedTransaction } from './leadership';
import { memoryOf } from './observe';
import { publicMessage } from './http';
import { notifyTeamKills } from './webhook-delivery';
import { isDemoServer } from './env';
import { drainMockFeed } from './mockgame';
import { ingestBatch } from './feed';
import { servers, type ServerRow } from './db/schema';
import type { KillView, Player } from '$lib/types';

export async function onKillsIngested(
	env: Env,
	serverId: string,
	kills: KillView[]
): Promise<void> {
	if (!kills.length) return;
	emit({ type: 'kills', serverId, kills });
	try {
		await actOnKillRate(env, serverId, kills);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] kill-rate rules on ${serverId}:`, publicMessage(err));
	}
	// what the rules' texts say about a killer, their stats read once for the whole batch
	const vars = killerVars(env, serverId);
	try {
		await actOnKillDistance(env, serverId, kills, vars);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] kill-distance rules on ${serverId}:`, publicMessage(err));
	}
	const teamKills = kills.filter((k) => k.teamKill && k.killer);
	if (!teamKills.length) return;
	const m = memoryOf(serverId);
	void notifyTeamKills(env, serverId, m?.status?.serverName || m?.server.name || '', teamKills);
	try {
		await actOnTeamKills(env, serverId, teamKills, vars);
	} catch (err) {
		if (err instanceof LostOwnership) return;
		console.warn(`[warcon] team-kill rules on ${serverId}:`, publicMessage(err));
	}
}

/**
 * Each Kill rate rule's window of recent kills per player, in this process's memory: kills are
 * acted on only in the worker, and a restart starting the windows over costs a flag, not data
 * (the kills themselves are in the table). Kept only for servers with the rule on.
 */
const rateTracks = new Map<string, { serverId: string; tracks: RateTracks }>();

async function actOnKillRate(env: Env, serverId: string, batch: KillView[]): Promise<void> {
	const rows = (await enabledTriggers(env, serverId)).filter((r) => r.kind === 'kill_rate');
	const live = new Set(rows.map((r) => r.id));
	for (const [id, t] of rateTracks)
		if (t.serverId === serverId && !live.has(id)) rateTracks.delete(id);
	if (!rows.length) return;
	const times = killTimes(
		Date.parse(batch[0].ts),
		batch.map((k) => k.eventTime)
	);
	const counted = batch
		.map((k, i) => ({ k, at: times[i] }))
		.filter(({ k }) =>
			countsForRate({ killer: k.killer?.steamId, suicide: k.suicide, cause: k.cause })
		)
		.sort((a, b) => a.at - b.at);
	const now = Date.now();
	const out: Evaluation = { intents: [], updates: [] };
	// A flag starts the player's cooldown; if it cannot be queued, neither does the cooldown.
	const flagged: { track: RateTrack; before: number | null }[] = [];
	for (const row of rows) {
		const cfg = row.config as KillRateConfig;
		let entry = rateTracks.get(row.id);
		if (!entry) {
			entry = { serverId, tracks: new Map() };
			rateTracks.set(row.id, entry);
		}
		for (const { k, at } of counted) {
			const steamId = k.killer!.steamId;
			const before = entry.tracks.get(steamId)?.flaggedAt ?? null;
			const verdict = killRateStep(cfg, entry.tracks, steamId, at, k.headshot);
			if (!verdict) continue;
			flagged.push({ track: entry.tracks.get(steamId)!, before });
			const name = k.killer!.name;
			out.intents.push({
				trigger: row,
				action: KILL_RATE_FLAG,
				params: {},
				target: steamId,
				okMessage: `Flagged ${name}: ${verdict}`,
				detail: { name, verdict },
				steamId,
				dedupeKey: [row.id, steamId, k.eventId].join(':')
			});
			out.updates.push({
				id: row.id,
				lastFiredAt: new Date(),
				lastResult: `Flagging ${name}: ${verdict}`
			});
		}
		pruneTracks(cfg, entry.tracks, now);
	}
	if (!out.intents.length) return;
	let queued = 0;
	try {
		await withOwnedTransaction(env, async (tx) => {
			queued = await enqueueIntents(tx, serverId, out.intents);
			await applyTriggerUpdates(tx, out.updates);
		});
	} catch (err) {
		for (const f of flagged.reverse()) f.track.flaggedAt = f.before;
		throw err;
	}
	if (queued) wakeDelivery();
}

/**
 * Each Kill distance rule's counts in this process's memory, by server and rule: the match they
 * are for, the settings they were made under, and each player's count. A new match, or an edit of
 * the rule, starts them over; a restart or a handover forgets them, so a player acted on just
 * before can be acted on once more. Kept only for servers with the rule on.
 */
interface DistanceMemory {
	settings: string;
	match: string;
	tracks: DistanceTracks;
}
const distanceMemory = new Map<string, Map<string, DistanceMemory>>();

/** Forgets the Kill distance counts of one server (removed from the worker), or of every server. */
export function forgetKillDistance(serverId?: string): void {
	if (serverId) distanceMemory.delete(serverId);
	else distanceMemory.clear();
}

/**
 * The match a batch was stamped with when it came in: every kill of it carries the open match of
 * that moment (feed.ts), so any one says which; null when none was open.
 */
async function stampedMatch(env: Env, serverId: string, batch: KillView[]): Promise<number | null> {
	const at = new Date(batch[0].ts);
	const [stamp] = await env.db
		.select({ row: kills.matchRow })
		.from(kills)
		.where(
			and(
				eq(kills.serverId, serverId),
				eq(kills.eventType, 'killed'),
				eq(kills.parsedKill, true),
				eq(kills.eventId, batch[0].eventId),
				gte(kills.ts, new Date(at.getTime() - 60_000))
			)
		)
		.limit(1);
	return stamp?.row ?? null;
}

async function actOnKillDistance(
	env: Env,
	serverId: string,
	batch: KillView[],
	vars: KillerVars
): Promise<void> {
	const rows = (await enabledTriggers(env, serverId)).filter((r) => r.kind === 'kill_distance');
	let mine = distanceMemory.get(serverId);
	if (!rows.length) {
		if (mine) distanceMemory.delete(serverId);
		return;
	}
	const live = new Set(rows.map((r) => r.id));
	if (mine) for (const id of mine.keys()) if (!live.has(id)) mine.delete(id);
	// The kills each rule counts, in the order the game played them. Most batches have none, and
	// then nothing is read.
	const inOrder = [...batch].sort((a, b) => a.eventTime - b.eventTime);
	const counted = rows
		.map((row) => {
			const cfg = row.config as KillDistanceConfig;
			const hits = inOrder.filter((k) =>
				countsForDistance(cfg, {
					killer: k.killer?.steamId,
					suicide: k.suicide,
					cause: k.cause,
					distanceM: k.distanceM
				})
			);
			return { row, cfg, hits };
		})
		.filter((r) => r.hits.length);
	if (!counted.length) return;
	const now = Date.now();
	const match = matchKey(await stampedMatch(env, serverId, batch), Date.parse(batch[0].ts));
	if (!mine) distanceMemory.set(serverId, (mine = new Map()));
	const out: Evaluation = { intents: [], updates: [] };
	// Acting starts the player's hold; if the action cannot be queued, neither does the hold.
	const acted: { track: DistanceTrack; before: number | null }[] = [];
	for (const { row, cfg, hits } of counted) {
		const settings = killDistanceSettingsKey(cfg);
		let entry = mine.get(row.id);
		if (!entry || entry.match !== match || entry.settings !== settings) {
			entry = { settings, match, tracks: new Map() };
			mine.set(row.id, entry);
		}
		const caught: { k: KillView; steamId: string; count: number }[] = [];
		for (const k of hits) {
			const steamId = k.killer!.steamId;
			const before = entry.tracks.get(steamId)?.actedAt ?? null;
			const count = killDistanceStep(cfg, entry.tracks, steamId, now);
			if (count === null) continue;
			acted.push({ track: entry.tracks.get(steamId)!, before });
			caught.push({ k, steamId, count });
		}
		// a flag tells the player nothing; the rule's one text can be a ban reason, kept where staff
		// read it, so it has no org-wide stats whatever the action
		const stats = await vars.stats(
			cfg.action === 'flag' ? [] : caught.map((c) => ({ steamId: c.steamId, text: cfg.reason })),
			{ org: false }
		);
		for (const { k, steamId, count } of caught) {
			const name = k.killer!.name || steamId;
			const act = killDistanceAct(
				cfg,
				{ steamId, name, cause: k.cause, distanceM: k.distanceM },
				count,
				vars.of(k, stats, k.map ? { map: mapName(k.map) } : {})
			);
			out.intents.push({
				trigger: row,
				action: act.action,
				// the settings it was decided under: delivery sends it only while the rule still holds them
				params: { ...act.params, rule: settings },
				target: steamId,
				okMessage: act.okMessage,
				detail: { ...act.detail, eventId: k.eventId },
				steamId: act.steamId,
				dedupeKey: [row.id, steamId, k.eventId].join(':')
			});
			out.updates.push({ id: row.id, lastFiredAt: new Date(), lastResult: act.pending });
		}
	}
	if (!out.intents.length) return;
	let queued = 0;
	try {
		await withOwnedTransaction(env, async (tx) => {
			queued = await enqueueIntents(tx, serverId, out.intents);
			await applyTriggerUpdates(tx, out.updates);
		});
	} catch (err) {
		for (const a of acted.reverse()) a.track.actedAt = a.before;
		throw err;
	}
	if (queued) wakeDelivery();
}

/**
 * The placeholders of a message about a kill's killer: the server as the worker last saw it, the
 * killer (their side as the kill has it, their ping from the last player list) and their stats,
 * read once per player for the whole batch, whichever rules ask. Nothing is looked at until a rule
 * acts.
 */
function killerVars(env: Env, serverId: string) {
	let seen: { server: MessageVars; live: Map<string, Player> } | null = null;
	const look = () => {
		if (seen) return seen;
		const m = memoryOf(serverId);
		seen = {
			server: serverVars({
				name: m?.server.name ?? '',
				status: m?.status ?? null,
				startedAt: m?.startedAt ?? 0,
				now: Date.now()
			}),
			live: new Map((m?.players ?? []).map((p) => [p.steamId, p]))
		};
		return seen;
	};
	const read = statsReader(env, serverId);
	return {
		/** what these killers' texts tell them of their stats; nothing is read for none */
		stats: (wants: { steamId: string; text: string }[], sides?: { org: boolean }) =>
			statsFor(read, wants, sides),
		of: (k: KillView, stats: StatsRead, own: MessageVars): MessageVars => {
			const { server, live } = look();
			const steamId = k.killer!.steamId;
			const p = live.get(steamId);
			return messageVars(
				server,
				{
					name: k.killer!.name || steamId,
					steamId,
					faction: k.killer!.faction ?? p?.faction ?? null,
					ping: p?.ping
				},
				statsOf(stats, steamId),
				own
			);
		}
	};
}
type KillerVars = ReturnType<typeof killerVars>;

/** A player's team kills in a match by one cause (null for none), as a rule counts them. */
interface CauseCount {
	cause: string | null;
	n: number;
}

/**
 * How many team kills each of these players has in the match the batch arrived in, up to and
 * including the batch, by cause: the rows that carry that match, as its match page counts them.
 * Leaving and joining again does not start the count over, and a batch acted on late does not
 * count the ones that came after it. A batch that came in while no match was open (a server's
 * first seconds, or just after its stats were purged) counts with the other such kills of the
 * hour before.
 */
async function teamKillsThisMatch(
	env: Env,
	serverId: string,
	batch: KillView[],
	steamIds: string[]
): Promise<Map<string, CauseCount[]>> {
	// Every kill of a batch was stamped with the match open at receipt (feed.ts); any one says which.
	const at = new Date(batch[0].ts);
	const [stamp] = await env.db
		.select({ row: kills.matchRow, startedAt: matches.startedAt, endedAt: matches.endedAt })
		.from(kills)
		.leftJoin(matches, and(eq(matches.id, kills.matchRow), eq(matches.serverId, kills.serverId)))
		.where(
			and(
				eq(kills.serverId, serverId),
				eq(kills.eventType, 'killed'),
				eq(kills.parsedKill, true),
				eq(kills.eventId, batch[0].eventId),
				gte(kills.ts, new Date(at.getTime() - 60_000))
			)
		)
		.limit(1);
	const match =
		stamp?.row != null && stamp.startedAt
			? killsOfMatch(stamp.row, stamp.startedAt, stamp.endedAt)
			: null;
	const rows = await env.db
		.select({ steamId: kills.killerSteamId, cause: kills.cause, n: sql<number>`COUNT(*)` })
		.from(kills)
		.where(
			and(
				eq(kills.serverId, serverId),
				eq(kills.eventType, 'killed'),
				eq(kills.parsedKill, true),
				inArray(kills.killerSteamId, steamIds),
				eq(kills.teamKill, true),
				stamp?.row != null ? eq(kills.matchRow, stamp.row) : isNull(kills.matchRow),
				gte(kills.ts, match?.from ?? new Date(at.getTime() - 3600_000)),
				lte(kills.ts, at)
			)
		)
		.groupBy(kills.killerSteamId, kills.cause);
	const out = new Map<string, CauseCount[]>();
	for (const r of rows) {
		const list = out.get(r.steamId!) ?? out.set(r.steamId!, []).get(r.steamId!)!;
		list.push({ cause: r.cause, n: Number(r.n) });
	}
	return out;
}

async function actOnTeamKills(
	env: Env,
	serverId: string,
	teamKills: KillView[],
	vars: KillerVars
): Promise<void> {
	// Each rule acts on the last team kill of each killer in the batch that it counts; a batch
	// whose team kills no rule counts reads nothing.
	const rules = (await enabledTriggers(env, serverId))
		.filter((r) => r.kind === 'team_kill')
		.map((row) => {
			const cfg = row.config as TeamKillConfig;
			const byKiller = new Map<string, KillView>();
			for (const k of teamKills)
				if (countsForTeamKill(cfg, k.cause)) byKiller.set(k.killer!.steamId, k);
			return { row, cfg, byKiller };
		})
		.filter((r) => r.byKiller.size);
	if (!rules.length) return;
	const out: Evaluation = { intents: [], updates: [] };
	const counts = await teamKillsThisMatch(env, serverId, teamKills, [
		...new Set(rules.flatMap((r) => [...r.byKiller.keys()]))
	]);
	for (const { row, cfg, byKiller } of rules) {
		const acts = [...byKiller].flatMap(([steamId, k]) => {
			const count = (counts.get(steamId) ?? []).reduce(
				(n, c) => (countsForTeamKill(cfg, c.cause) ? n + c.n : n),
				0
			);
			const stage = teamKillStage(cfg, count);
			return stage ? [{ steamId, k, count, kick: stage === 'kick' }] : [];
		});
		const stats = await vars.stats(
			acts.map((a) => ({ steamId: a.steamId, text: a.kick ? cfg.kickReason : cfg.warnMessage }))
		);
		for (const { steamId, k, count, kick } of acts) {
			const name = k.killer!.name;
			// the map the kill was on, which a map change can leave behind the server's
			const v = vars.of(k, stats, {
				victim: k.victim.name,
				count,
				...(k.map ? { map: mapName(k.map) } : {})
			});
			const text = kick
				? renderTemplate(cfg.kickReason, v, MAX_REASON)
				: renderTemplate(cfg.warnMessage, v, MAX_CHAT);
			out.intents.push({
				trigger: row,
				action: kick ? 'kick' : 'whisper',
				params: kick ? { steamId, reason: text } : { steamId, message: text },
				target: steamId,
				okMessage: kick
					? `Kicked ${name} after ${count} team kill${count === 1 ? '' : 's'}`
					: `Whispered ${name} (${count} team kill${count === 1 ? '' : 's'})`,
				detail: { name, victim: k.victim.name, count, eventId: k.eventId },
				steamId,
				dedupeKey: [row.id, steamId, k.eventId].join(':')
			});
			out.updates.push({
				id: row.id,
				lastFiredAt: new Date(),
				lastResult: kick ? `Kicking ${name} (${count})` : `Whispering ${name} (${count})`
			});
		}
	}
	if (!out.intents.length) return;
	let queued = 0;
	await withOwnedTransaction(env, async (tx) => {
		queued = await enqueueIntents(tx, serverId, out.intents);
		await applyTriggerUpdates(tx, out.updates);
	});
	if (queued) wakeDelivery();
}

/**
 * The demo server's kills, fed through the same path as a real server's once its feed is turned
 * on (Config tab): the mock has no process of its own to post from, so the worker drains
 * its queue after each observation.
 */
export async function feedDemoKills(env: Env, server: ServerRow): Promise<void> {
	if (!isDemoServer(env, server)) return;
	const batch = drainMockFeed(server.id);
	if (!batch) return;
	const [row] = await env.db
		.select({ on: sql<boolean>`${servers.feedTokenHash} IS NOT NULL` })
		.from(servers)
		.where(eq(servers.id, server.id));
	if (!row?.on) return;
	const r = await ingestBatch(env, server.id, batch);
	if (r.kills.length) await onKillsIngested(env, server.id, r.kills);
}
