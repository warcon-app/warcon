// What happens in the worker once the kill feed has written a batch: the kills go out on the
// event bus (the SSE route fans them to browsers; in the split roles every web process gets them
// through the relay stream), and the team-kill rules get their turn. Their intents go through
// the same outbox as every other trigger, so delivery, audit and the Discord mirror are shared.
// The Kill rate, Kill distance, Name change, Bounty and Death whisper rules see every batch; the
// rest of the work is for batches with team kills.
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { forLog } from './http';
import type { Env } from './env';
import { emit } from './events';
import { kills, matches } from './db/schema';
import { killsOfMatch } from './matches';
import {
	bountyLapse,
	enabledTriggers,
	killDistanceAct,
	renderTemplate,
	statsFor,
	statsOf,
	statsReader,
	teamKillStage,
	type Evaluation,
	type StatsRead,
	type TriggerUpdate
} from './triggers';
import {
	DEATH_WHISPER_KEEP_MS,
	deathBlanks,
	deathVars,
	deathWhisperStep,
	pruneWhispered,
	type DeathWhisperConfig,
	type DeathWhisperPick,
	type WhisperedTracks
} from './death-whisper';
import { keptVars, messageVars, serverVars, type MessageVars } from './message-vars';
import { mapName } from '$lib/format';
import { seenAs } from '$lib/anonymous';
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
	KILL_DISTANCE_SKIP,
	killDistanceSettingsKey,
	killDistanceStep,
	killsAfterDeath,
	matchKey,
	notCountedMessage,
	type DistanceTrack,
	type DistanceTracks,
	type KillDistanceConfig,
	type LastDeaths
} from './kill-distance';
import {
	nameChangeSettingsKey,
	nameChangeStep,
	namesShownElse,
	pruneNameTracks,
	type NameChangeConfig,
	type NameTracks
} from './name-change';
import { recordAliases } from './aliases';
import { NAME_FLAG } from './name-filter';
import { applyTriggerUpdates, enqueueIntents, wakeDelivery } from './outbox';
import { LostOwnership, withOwnedTransaction } from './leadership';
import { memoryOf } from './observe';
import { readLiveRows } from './live';
import { onMatchFeed } from './match-feed';
import { publicMessage } from './http';
import { notifyBounty, notifyTeamKills, type BountyCard } from './webhook-delivery';
import {
	BOUNTY_CLAIM,
	BOUNTY_REWARD,
	bountyState,
	fromEarlierMatch,
	bountyStep,
	bountyTrack,
	keepBounties,
	rewardWords,
	type BountyConfig,
	type BountyKill,
	type BountyPlayer,
	type OpenBounty
} from './bounty';
import { isDemoServer } from './env';
import { drainMockFeed } from './mockgame';
import { ingestBatch } from './feed';
import { outbox, servers, type ServerRow, type TriggerRow } from './db/schema';
import type { KillView, Player } from '$lib/types';

export async function onKillsIngested(
	env: Env,
	serverId: string,
	kills: KillView[]
): Promise<void> {
	if (!kills.length) return;
	emit({ type: 'kills', serverId, kills });
	const named = namedIn(kills, hiddenOn(serverId));
	try {
		await recordFeedNames(env, serverId, kills, named);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] kill feed names on ${serverId}:`, publicMessage(err));
	}
	try {
		await actOnKillRate(env, serverId, kills);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] kill-rate rules on ${serverId}:`, publicMessage(err));
	}
	// what the rules' texts say about a killer, their stats read once for the whole batch
	const vars = killerVars(env, serverId);
	await vars.prime();
	try {
		await actOnKillDistance(env, serverId, kills, vars);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] kill-distance rules on ${serverId}:`, publicMessage(err));
	}
	try {
		await actOnNameChange(env, serverId, named, vars);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] name-change rules on ${serverId}:`, publicMessage(err));
	}
	try {
		await actOnBounty(env, serverId, kills, vars);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] bounty rules on ${serverId}:`, publicMessage(err));
	}
	try {
		await actOnDeathWhisper(env, serverId, kills, vars);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] death whisper rules on ${serverId}:`, publicMessage(err));
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
 * Both players of every kill as the feed named them, in the order the game played them; a suicide
 * names its player once, and the environment no one. A player in anonymous mode whom the feed
 * names by their hidden name is left out: that is the game showing them as it shows them to
 * everyone, neither a name of their own making (aliases.ts) nor a change of name (name-change.ts).
 * The feeds seen so far name such a player by their own name; this holds either way.
 */
function namedIn(batch: KillView[], hidden: ReadonlyMap<string, string> = new Map()) {
	return [...batch]
		.sort((a, b) => a.eventTime - b.eventTime)
		.flatMap((k) => [
			...(k.killer?.steamId ? [{ ...k.killer, k }] : []),
			...(k.victim.steamId && k.victim.steamId !== k.killer?.steamId ? [{ ...k.victim, k }] : [])
		])
		.filter((p) => hidden.get(p.steamId) !== p.name);
}
type Named = ReturnType<typeof namedIn>;

/** The hidden names the player list holds for its players in anonymous mode, by SteamID
 *  ($lib/anonymous); read once a look, as listedOf. */
const hiddenCache = new WeakMap<Player[], Map<string, string>>();
function hiddenOn(serverId: string): ReadonlyMap<string, string> {
	const players = memoryOf(serverId)?.players;
	if (!players) return new Map();
	let hidden = hiddenCache.get(players);
	if (!hidden)
		hiddenCache.set(
			players,
			(hidden = new Map(
				players.flatMap((p) => (p.hiddenName ? [[p.steamId, p.hiddenName] as const] : []))
			))
		);
	return hidden;
}

/** The names the server's player list holds, by SteamID, from the worker's last look at it (read
 *  once a look, however many batches come in meanwhile). */
const listedCache = new WeakMap<Player[], Map<string, string>>();
function listedOf(serverId: string): ReadonlyMap<string, string> {
	const players = memoryOf(serverId)?.players;
	if (!players) return new Map();
	let listed = listedCache.get(players);
	if (!listed)
		listedCache.set(players, (listed = new Map(players.map((p) => [p.steamId, p.name]))));
	return listed;
}

/**
 * Keeps, for staff, the names this batch showed that were not the ones the list holds for their
 * players (aliases.ts), on every server with the feed whatever its rules: a name the same as the
 * list's, nearly every one, costs a lookup and a compare.
 */
async function recordFeedNames(
	env: Env,
	serverId: string,
	batch: KillView[],
	named: Named
): Promise<void> {
	const listed = listedOf(serverId);
	if (!listed.size) return;
	const found = namesShownElse(named, listed);
	if (!found.length) return;
	const at = new Date(Math.max(...batch.map((k) => Date.parse(k.ts))));
	await withOwnedTransaction(env, (tx) =>
		recordAliases(
			tx,
			serverId,
			found.map((a) => ({ ...a, firstSeen: at, lastSeen: at }))
		)
	);
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
/**
 * Each server's last deaths per player, so a kill just after the killer's own death is not counted
 * (killsAfterDeath) when the death came in an earlier batch. Kept, and forgotten, with the counts.
 */
const lastDeaths = new Map<string, LastDeaths>();

/** Forgets the Kill distance counts of one server (removed from the worker), or of every server. */
export function forgetKillDistance(serverId?: string): void {
	if (serverId) {
		distanceMemory.delete(serverId);
		lastDeaths.delete(serverId);
	} else {
		distanceMemory.clear();
		lastDeaths.clear();
	}
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
		lastDeaths.delete(serverId);
		return;
	}
	const live = new Set(rows.map((r) => r.id));
	if (mine) for (const id of mine.keys()) if (!live.has(id)) mine.delete(id);
	// The kills each rule counts, in the order the game played them. Most batches have none, and
	// then nothing is read; every batch's deaths are noted all the same.
	const inOrder = [...batch].sort((a, b) => a.eventTime - b.eventTime);
	let deaths = lastDeaths.get(serverId);
	if (!deaths) lastDeaths.set(serverId, (deaths = new Map()));
	const afterDeath = killsAfterDeath(
		deaths,
		inOrder.map((k) => ({
			eventId: k.eventId,
			eventTime: k.eventTime,
			killer: k.killer?.steamId,
			victim: k.victim.steamId
		})),
		Date.parse(batch[0].ts)
	);
	const counted = rows
		.map((row) => {
			const cfg = row.config as KillDistanceConfig;
			const hits: KillView[] = [];
			// the kills it would have counted but for the killer's own death just before
			const leftOut: { k: KillView; afterS: number }[] = [];
			for (const k of inOrder) {
				const kill = {
					killer: k.killer?.steamId,
					suicide: k.suicide,
					cause: k.cause,
					distanceM: k.distanceM
				};
				const afterS = afterDeath.get(k.eventId);
				if (countsForDistance(cfg, { ...kill, afterOwnDeath: afterS !== undefined })) hits.push(k);
				else if (afterS !== undefined && countsForDistance(cfg, { ...kill, afterOwnDeath: false }))
					leftOut.push({ k, afterS });
			}
			return { row, cfg, hits, leftOut };
		})
		.filter((r) => r.hits.length || r.leftOut.length);
	if (!counted.length) return;
	const now = Date.now();
	const match = counted.some((r) => r.hits.length)
		? matchKey(await stampedMatch(env, serverId, batch), Date.parse(batch[0].ts))
		: '';
	if (!mine) distanceMemory.set(serverId, (mine = new Map()));
	const out: Evaluation = { intents: [], updates: [] };
	// Acting starts the player's hold; if the action cannot be queued, neither does the hold.
	const acted: { track: DistanceTrack; before: number | null }[] = [];
	for (const { row, cfg, hits, leftOut } of counted) {
		const settings = killDistanceSettingsKey(cfg);
		// Each left-out kill is noted in the audit trail, so staff can see why the rule let it be.
		for (const { k, afterS } of leftOut) {
			const steamId = k.killer!.steamId;
			const name = k.killer!.name || steamId;
			out.intents.push({
				trigger: row,
				action: KILL_DISTANCE_SKIP,
				params: { rule: settings },
				target: steamId,
				okMessage: notCountedMessage(name, k.cause, k.distanceM, afterS),
				detail: {
					name,
					cause: k.cause,
					distanceM: k.distanceM,
					afterDeathS: Math.round(afterS * 10) / 10,
					eventId: k.eventId
				},
				steamId: null,
				dedupeKey: [row.id, steamId, k.eventId, 'skip'].join(':')
			});
		}
		if (!hits.length) continue;
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
 * Each Name change rule's tracks in this process's memory, by rule: the players the feed has shown
 * under a name not their own, with their changes within the window, and the settings they were
 * counted under (an edit starts them over). A restart or a handover forgets them, so a change across
 * one is missed, never made up. Kept only for servers with the rule on.
 */
const nameTracks = new Map<
	string,
	{ serverId: string; settings: string; prunedAt: number; tracks: NameTracks }
>();
/** How often a rule's tracks are swept of players not named within its window. */
const NAME_PRUNE_MS = 60_000;

/** Forgets the Name change tracks of one server (removed from the worker), or of every server. */
export function forgetNameChange(serverId?: string): void {
	if (!serverId) return nameTracks.clear();
	for (const [id, t] of nameTracks) if (t.serverId === serverId) nameTracks.delete(id);
}

async function actOnNameChange(
	env: Env,
	serverId: string,
	shown: Named,
	vars: KillerVars
): Promise<void> {
	const rows = (await enabledTriggers(env, serverId)).filter((r) => r.kind === 'name_change');
	const live = new Set(rows.map((r) => r.id));
	for (const [id, t] of nameTracks)
		if (t.serverId === serverId && !live.has(id)) nameTracks.delete(id);
	if (!rows.length) return;
	// The names the server lists its players under now: nothing to hold the feed against while the
	// list is empty (a map loading) or not read yet.
	const m = memoryOf(serverId);
	const listed = listedOf(serverId);
	if (!listed.size || !shown.length) return;
	const now = Date.now();
	const out: Evaluation = { intents: [], updates: [] };
	// Each rule's tracks move on as it reads; if its actions cannot be queued, they move back.
	const undos: (() => void)[] = [];
	try {
		for (const row of rows) {
			const cfg = row.config as NameChangeConfig;
			// the settings it decides under: delivery sends its rows only while the rule still holds them
			const settings = nameChangeSettingsKey(cfg);
			let entry = nameTracks.get(row.id);
			if (!entry || entry.settings !== settings)
				nameTracks.set(row.id, (entry = { serverId, settings, prunedAt: now, tracks: new Map() }));
			if (now - entry.prunedAt >= NAME_PRUNE_MS) {
				pruneNameTracks(cfg, entry.tracks, now);
				entry.prunedAt = now;
			}
			// A kick rule that spares reserved slots flags such a player instead, and flags everyone
			// until the worker has read the reserved list.
			const kicks = (steamId: string) =>
				cfg.action === 'kick' &&
				!(cfg.spareReserved && (!m?.reservedAt || m.reserved.has(steamId)));
			const { hits, undo } = nameChangeStep(cfg, entry.tracks, shown, listed, now, {
				kicked: kicks
			});
			undos.push(undo);
			if (!hits.length) continue;
			const stats = await vars.stats(
				hits
					.filter((h) => kicks(h.player.steamId))
					.map((h) => ({ steamId: h.player.steamId, text: cfg.reason }))
			);
			for (const h of hits) {
				const p = h.player;
				const kick = kicks(p.steamId);
				const spared = cfg.action === 'kick' && !kick;
				out.intents.push({
					trigger: row,
					action: kick ? 'kick' : NAME_FLAG,
					params: kick
						? {
								steamId: p.steamId,
								reason: renderTemplate(
									cfg.reason,
									vars.about(p, stats, { previous: h.listed }),
									MAX_REASON
								),
								rule: settings
							}
						: { rule: settings },
					target: p.steamId,
					okMessage: `${kick ? 'Kicked' : 'Flagged'} ${h.listed}${spared ? ' (reserved slot)' : ''}: ${h.verdict}`,
					detail: {
						name: h.listed,
						shown: p.name,
						holder: h.holder,
						changes: h.count,
						verdict: h.verdict,
						eventId: p.k.eventId
					},
					steamId: p.steamId,
					dedupeKey: [row.id, p.steamId, p.k.eventId].join(':')
				});
				out.updates.push({
					id: row.id,
					lastFiredAt: new Date(),
					lastResult: `${kick ? 'Kicking' : 'Flagging'} ${h.listed}: ${h.verdict}`
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
	} catch (err) {
		for (const undo of undos.reverse()) undo();
		throw err;
	}
}

/** A kill as the Bounty rule reads it. */
const bountyKill = (k: KillView): BountyKill => ({
	eventId: k.eventId,
	killer: k.killer
		? { steamId: k.killer.steamId, name: k.killer.name, faction: k.killer.faction }
		: null,
	victim: { steamId: k.victim.steamId, name: k.victim.name, faction: k.victim.faction },
	suicide: k.suicide,
	teamKill: k.teamKill
});

const dateOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The Bounty rule (one per server) over a batch: runs grow and end in the order the game played the
 * kills, a run that reaches the rule's count while enough players are on and no bounty is open sets
 * one (announced), and the first enemy kill of the marked player claims it (noted, announced when the
 * rule says, the claimer whispered when it says, and the reserved slot queued). The open bounty is
 * written to the rule's row with the actions; if they cannot be written, the bounty in memory goes
 * back to what it was. Players of the Bounties channel get a card once it is written.
 */
async function actOnBounty(
	env: Env,
	serverId: string,
	batch: KillView[],
	vars: KillerVars
): Promise<void> {
	const rows = (await enabledTriggers(env, serverId)).filter((r) => r.kind === 'bounty');
	keepBounties(serverId, new Set(rows.map((r) => r.id)));
	if (!rows.length) return;
	const m = memoryOf(serverId);
	// The most anyone says is on: a status a few seconds old must not hide a full list.
	const on = Math.max(m?.status?.playerCount || 0, m?.players.length ?? 0);
	const sorted = [...batch].sort((a, b) => a.eventTime - b.eventTime);
	const inOrder = sorted.map(bountyKill);
	const byEvent = new Map(sorted.map((k) => [k.eventId, k]));
	const serverName = m?.status?.serverName || m?.server.name || '';
	const now = Date.now();
	for (const row of rows) {
		const cfg = row.config as BountyConfig;
		const { version, track } = bountyTrack(row);
		const before = track.open;
		const out: Evaluation = { intents: [], updates: [] };
		const cards: BountyCard[] = [];
		// The match this batch was stamped with, read only when a bounty is set or its player dies.
		let stamped: string | undefined;
		const batchMatch = async () =>
			(stamped ??= matchKey(await stampedMatch(env, serverId, batch), Date.parse(batch[0].ts)));
		// A bounty read back after a restart can be from a match that ended while no worker watched:
		// the batch that could claim it says which match it is in, and an earlier match's lapses.
		const open = track.open;
		if (
			open?.match.startsWith('m') &&
			inOrder.some((k) => k.victim.steamId === open.steamId) &&
			fromEarlierMatch(open.match, await batchMatch()) &&
			track.open === open
		) {
			track.open = null;
			track.runs.clear();
			const lapse = bountyLapse(row, cfg, version, open, 'match', new Date(now), sorted[0].map);
			out.intents.push(lapse.intent);
			out.updates.push(lapse.update);
			cards.push(lapse.card);
		}
		const events = bountyStep(cfg, track, inOrder, { canMark: on >= cfg.minPlayers, now });
		if (!events.length && !out.intents.length) continue;
		// a bounty set here is of the batch's match, and on the player as the others know them
		for (const e of events)
			if (e.kind === 'set') {
				e.bounty.match = await batchMatch();
				const hidden = vars.hiddenOf(e.bounty.steamId);
				if (hidden) e.bounty.hiddenName = hidden;
			}
		const reward = rewardWords(cfg);
		const slot = cfg.reward === 'slot';
		const until = slot ? dateOf(new Date(now + cfg.slotDays * 86400_000)) : '';
		const own = (target: string, streak: number, map: string) => ({
			target,
			streak,
			reward,
			days: slot ? cfg.slotDays : '',
			until,
			...(map ? { map: mapName(map) } : {})
		});
		// said to the whole server, or to the claimer, so no org-wide stats (keptVars)
		const stats = await vars.stats(
			events.flatMap((e) =>
				e.kind === 'set'
					? [{ steamId: e.bounty.steamId, text: cfg.setMessage }]
					: [
							{ steamId: e.claimer.steamId, text: cfg.claimMessage },
							{ steamId: e.claimer.steamId, text: cfg.whisper }
						]
			),
			{ org: false }
		);
		// The two broadcasts are for everyone, so their players go by the names the others see; the
		// whisper is the claimer's own, and names the marked player the same way.
		const announce = (text: string, who: BountyPlayer, extra: MessageVars) =>
			renderTemplate(text, keptVars(vars.toOthers(who, stats, extra)), MAX_CHAT);
		const tell = (text: string, who: BountyPlayer, extra: MessageVars) =>
			renderTemplate(text, keptVars(vars.about(who, stats, extra)), MAX_CHAT);
		/** the marked player to the others: as the list has them now, else as when it was set */
		const marked = (b: OpenBounty) => vars.shown(b.steamId, seenAs(b));
		const card = { reward, orgWide: slot && cfg.scope === 'org', at: new Date(now).toISOString() };
		for (const e of events) {
			const k = byEvent.get(e.kill.eventId)!;
			const dedupe = (what: string) => [row.id, what, k.eventId].join(':');
			if (e.kind === 'set') {
				const b = e.bounty;
				const message = announce(cfg.setMessage, b, own(marked(b), b.streak, k.map));
				out.intents.push({
					trigger: row,
					action: 'broadcast',
					params: { message },
					target: b.steamId,
					okMessage: `Announced the bounty on ${b.name} (${b.streak} kills).`,
					detail: { name: b.name, streak: b.streak, stage: 'set', eventId: k.eventId },
					steamId: null,
					dedupeKey: dedupe('set')
				});
				out.updates.push({
					id: row.id,
					lastFiredAt: new Date(now),
					lastResult: `Bounty on ${b.name} (${b.streak} kills)`
				});
				cards.push({
					...card,
					kind: 'set',
					map: k.map || null,
					name: marked(b),
					faction: b.faction,
					streak: b.streak
				});
				continue;
			}
			const b = e.bounty;
			const c = e.claimer;
			const claimer = c.name || c.steamId;
			const claimed = `${claimer} claimed the bounty on ${b.name} (a run of ${b.best}).`;
			const extra = own(marked(b), b.best, k.map);
			out.intents.push({
				trigger: row,
				action: BOUNTY_CLAIM,
				params: {},
				target: c.steamId,
				okMessage: claimed,
				detail: {
					name: claimer,
					target: b.name,
					targetSteamId: b.steamId,
					run: b.best,
					eventId: k.eventId
				},
				steamId: null,
				dedupeKey: dedupe('claim')
			});
			if (cfg.claimMessage)
				out.intents.push({
					trigger: row,
					action: 'broadcast',
					params: { message: announce(cfg.claimMessage, c, extra) },
					target: c.steamId,
					okMessage: `Announced ${claimer}'s claim on ${b.name}.`,
					detail: { name: claimer, target: b.name, stage: 'claim', eventId: k.eventId },
					steamId: null,
					dedupeKey: dedupe('claimed')
				});
			if (slot)
				out.intents.push({
					trigger: row,
					action: BOUNTY_REWARD,
					params: {
						steamId: c.steamId,
						name: claimer,
						reason: `Bounty on ${b.name}, ${serverName}`.slice(0, 200),
						slotDays: cfg.slotDays,
						scope: cfg.scope
					},
					target: c.steamId,
					okMessage: `Reserved a slot for ${claimer}.`,
					detail: { name: claimer, target: b.name, slotDays: cfg.slotDays },
					// The slot was won; it is granted even if the claimer leaves before delivery.
					steamId: null,
					dedupeKey: dedupe('reward')
				});
			if (cfg.whisper)
				out.intents.push({
					trigger: row,
					action: 'whisper',
					params: { steamId: c.steamId, message: tell(cfg.whisper, c, extra) },
					target: c.steamId,
					okMessage: `Whispered ${claimer}.`,
					detail: { name: claimer },
					steamId: c.steamId,
					dedupeKey: dedupe('whisper')
				});
			out.updates.push({
				id: row.id,
				lastFiredAt: new Date(now),
				lastResult: claimed.slice(0, -1)
			});
			cards.push({
				...card,
				kind: 'claim',
				map: k.map || null,
				claimer: vars.shown(c.steamId, claimer),
				target: marked(b),
				run: b.best
			});
		}
		// The open bounty as it stands after the batch, on the last update (they are applied in order).
		const state = bountyState(version, track.open);
		out.updates[out.updates.length - 1].state = state;
		const after = track.open;
		let queued = 0;
		try {
			await withOwnedTransaction(env, async (tx) => {
				queued = await enqueueIntents(tx, serverId, out.intents);
				await applyTriggerUpdates(tx, out.updates);
			});
		} catch (err) {
			// Not written: the bounty goes back to what it was, unless a look has moved it on since.
			if (track.open === after) track.open = before;
			throw err;
		}
		row.state = state;
		if (queued) wakeDelivery();
		void notifyBounty(env, serverId, serverName, cards);
	}
}

/**
 * Each Death whisper rule's memory, by rule: the players it whispered within their cooldown and the
 * hour after (death-whisper.ts). It is filled from the rule's outbox rows the first time the rule
 * acts in this worker's ownership period, so a restart, a deploy or a handover keeps the cooldowns.
 * Kept only for servers with the rule on: switching a rule off drops its memory, switching it on
 * fills it again.
 */
interface WhisperMemory {
	serverId: string;
	tracks: WhisperedTracks;
	/** settles once the rule's outbox rows are in `tracks`: false when they could not be read */
	filled: Promise<boolean>;
	prunedAt: number;
	/** what the rule's row last said it waits for, so it is said once */
	held: '' | 'reserved';
}
const whisperMemory = new Map<string, WhisperMemory>();
/** How often a rule's memory is swept of players it no longer needs. */
const WHISPER_PRUNE_MS = 60_000;

/** Forgets the Death whisper memory of one server (removed from the worker), or of every server. */
export function forgetDeathWhispers(serverId?: string): void {
	if (!serverId) return whisperMemory.clear();
	for (const [id, t] of whisperMemory) if (t.serverId === serverId) whisperMemory.delete(id);
}

/**
 * Who the rule whispered within its cooldown and the hour after, and with which message, from its
 * own outbox rows (`outbox_server_idx` over that span of the server's rows). A row counts from when
 * the rule decided it, as the memory does, whatever became of it.
 */
async function whisperedBefore(env: Env, row: TriggerRow, now: number): Promise<WhisperedTracks> {
	const cfg = row.config as DeathWhisperConfig;
	const since = new Date(now - cfg.cooldownMinutes * 60_000 - DEATH_WHISPER_KEEP_MS);
	const rows = await env.db
		.selectDistinctOn([outbox.steamId], {
			steamId: outbox.steamId,
			at: outbox.createdAt,
			index: sql<string | null>`${outbox.detail} ->> 'index'`
		})
		.from(outbox)
		.where(
			and(
				eq(outbox.serverId, row.serverId),
				eq(outbox.triggerId, row.id),
				gte(outbox.createdAt, since)
			)
		)
		.orderBy(outbox.steamId, sql`${outbox.createdAt} DESC`);
	const tracks: WhisperedTracks = new Map();
	for (const r of rows) {
		if (!r.steamId) continue;
		const index = Number(r.index);
		tracks.set(r.steamId, {
			at: r.at.getTime(),
			index: r.index !== null && Number.isInteger(index) ? index : -1
		});
	}
	return tracks;
}

/** The rule's memory, its fill started the first time it is asked for. */
function whisperMemoryOf(env: Env, row: TriggerRow, now: number): WhisperMemory {
	const known = whisperMemory.get(row.id);
	if (known) return known;
	const mem: WhisperMemory = {
		serverId: row.serverId,
		tracks: new Map(),
		filled: Promise.resolve(false),
		prunedAt: now,
		held: ''
	};
	mem.filled = whisperedBefore(env, row, now).then(
		(read) => {
			// a whisper decided while the read ran is newer than anything it found
			for (const [id, t] of read) if (!mem.tracks.has(id)) mem.tracks.set(id, t);
			return true;
		},
		(err) => {
			// Asked again at the next batch; until then the rule whispers nobody rather than early.
			console.warn(`[warcon] death whisper memory on ${row.serverId}:`, forLog(err));
			if (whisperMemory.get(row.id) === mem) whisperMemory.delete(row.id);
			return false;
		}
	);
	whisperMemory.set(row.id, mem);
	return mem;
}

/**
 * The Death whisper rules over a batch: each player killed is whispered one of the rule's messages
 * at random, unless the rule whispered them within its cooldown, lists them, spares their reserved
 * slot, or fewer than its count are on. A server's batches are not serialised (gateway-local.ts),
 * so every rule decides and moves its memory with no await in between, and a batch that came in
 * meanwhile decides after it, from the moved memory. If the whispers cannot be written, the memory
 * goes back to what it was.
 */
async function actOnDeathWhisper(
	env: Env,
	serverId: string,
	batch: KillView[],
	vars: KillerVars
): Promise<void> {
	const rows = (await enabledTriggers(env, serverId)).filter((r) => r.kind === 'death_whisper');
	const live = new Set(rows.map((r) => r.id));
	for (const [id, t] of whisperMemory)
		if (t.serverId === serverId && !live.has(id)) whisperMemory.delete(id);
	if (!rows.length) return;
	const now = Date.now();
	const mems = rows.map((row) => whisperMemoryOf(env, row, now));
	const filled = await Promise.all(mems.map((m) => m.filled));
	// From here to the first await below, every rule decides.
	const m = memoryOf(serverId);
	// The most anyone says is on: a status a few seconds old must not hide a full list.
	const on = Math.max(m?.status?.playerCount || 0, m?.players.length ?? 0);
	const reserved = m?.reservedAt ? m.reserved : null;
	const sorted = [...batch].sort((a, b) => a.eventTime - b.eventTime);
	const byEvent = new Map(sorted.map((k) => [k.eventId, k]));
	const deaths = sorted
		.filter((k) => k.victim.steamId)
		.map((k) => ({
			steamId: k.victim.steamId,
			eventId: k.eventId,
			blank: deathBlanks(deathVars(k))
		}));
	const decided: { row: TriggerRow; cfg: DeathWhisperConfig; picks: DeathWhisperPick[] }[] = [];
	const undos: (() => void)[] = [];
	const updates: TriggerUpdate[] = [];
	const noted: (() => void)[] = [];
	rows.forEach((row, i) => {
		if (!filled[i]) return;
		const cfg = row.config as DeathWhisperConfig;
		const mem = mems[i];
		if (now - mem.prunedAt >= WHISPER_PRUNE_MS) {
			pruneWhispered(cfg, mem.tracks, now);
			mem.prunedAt = now;
		}
		const { picks, held, undo } = deathWhisperStep(cfg, mem.tracks, deaths, { now, on, reserved });
		undos.push(undo);
		if (held !== mem.held) {
			if (held)
				updates.push({ id: row.id, lastResult: 'Waiting for the reserved slots to be read' });
			noted.push(() => (mem.held = held));
		}
		if (picks.length) decided.push({ row, cfg, picks });
	});
	if (!decided.length && !updates.length) return;
	try {
		const out: Evaluation = { intents: [], updates };
		for (const { row, cfg, picks } of decided) {
			// a whisper to the player alone: their stats, here and across the organisation
			const stats = await vars.stats(
				picks.map((p) => ({ steamId: p.steamId, text: cfg.messages[p.index] }))
			);
			for (const p of picks) {
				const k = byEvent.get(p.eventId)!;
				const name = k.victim.name || p.steamId;
				// the killer as the player who died knows them: under the hidden name in anonymous mode
				const death = deathVars(k);
				const message = renderTemplate(
					cfg.messages[p.index],
					vars.about(k.victim, stats, {
						...death,
						...(death.killer && k.killer
							? { killer: vars.shown(k.killer.steamId, String(death.killer)) }
							: {}),
						...(k.map ? { map: mapName(k.map) } : {})
					}),
					MAX_CHAT
				);
				out.intents.push({
					trigger: row,
					action: 'whisper',
					params: { steamId: p.steamId, message },
					target: p.steamId,
					okMessage: `Whispered ${name}.`,
					// which message, so the memory filled after a restart knows it; never the text, which
					// stays in the row's params as every rule whisper's does
					detail: { name, index: p.index, eventId: p.eventId },
					steamId: p.steamId,
					dedupeKey: [row.id, p.steamId, p.eventId].join(':')
				});
			}
			const first = byEvent.get(picks[0].eventId)!;
			out.updates.push({
				id: row.id,
				lastFiredAt: new Date(now),
				lastResult:
					picks.length === 1
						? `Whispering ${first.victim.name || first.victim.steamId}`
						: `Whispering ${picks.length} players`
			});
		}
		let queued = 0;
		await withOwnedTransaction(env, async (tx) => {
			queued = await enqueueIntents(tx, serverId, out.intents);
			await applyTriggerUpdates(tx, out.updates);
		});
		for (const n of noted) n();
		if (queued) wakeDelivery();
	} catch (err) {
		for (const undo of undos.reverse()) undo();
		throw err;
	}
}

/**
 * The placeholders of a message about a kill's killer (or either of its players): the server as the
 * worker last saw it, the player (their side as the kill has it, their ping from the last player
 * list) and their stats, read once per player for the whole batch, whichever rules ask. Nothing is
 * looked at until a rule acts.
 */
/** Nobody's stats: every stats placeholder reads as unknown. */
const STATS_UNSAID: StatsRead = { here: null, org: null };

/** How old the stored player list may be for a worker that has not looked yet to go by it. */
const STORED_LIST_MAX_AGE_MS = 5 * 60_000;

function killerVars(env: Env, serverId: string) {
	let seen: {
		server: MessageVars;
		live: Map<string, Player>;
		open: ReadonlyMap<string, { hiddenName: string | null; anonymous: boolean }>;
	} | null = null;
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
			live: new Map((m?.players ?? []).map((p) => [p.steamId, p])),
			open: m?.presence.open ?? new Map()
		};
		return seen;
	};
	const read = statsReader(env, serverId);
	/** who was in anonymous mode in the live view the worker before this one stored (prime) */
	let stored: ReadonlyMap<string, string> | null = null;
	/**
	 * The hidden name the other players see in place of a player's own ($lib/anonymous): what the
	 * player list says of them now, or, for one gone from the list a moment ago, what their session
	 * saw at its last look (a session that left the mode keeps its hidden name, and gives none
	 * here). The feed names a player by their own name, so this is asked by SteamID.
	 */
	const hiddenOf = (steamId: string | null | undefined): string | undefined => {
		if (!steamId) return undefined;
		if (stored) return stored.get(steamId);
		const { live, open } = look();
		const on = live.get(steamId);
		if (on) return on.hiddenName || undefined;
		const session = open.get(steamId);
		return (session?.anonymous && session.hiddenName) || undefined;
	};
	return {
		/**
		 * Before a rule speaks. A worker that has just started has not read the player list yet (its
		 * first look comes within thirty seconds) while kills already arrive, so it would take
		 * everyone for a player out of anonymous mode. Until that first look, who is in the mode is
		 * read from the live view the worker before it stored, when that is fresh enough to mean
		 * the same players. One small read, and none once the list has been looked at.
		 */
		prime: async (): Promise<void> => {
			if (memoryOf(serverId)?.playersAt) return;
			try {
				const live = (await readLiveRows(env, [serverId])).get(serverId);
				const at = live?.playersAt ? Date.parse(live.playersAt) : NaN;
				if (!live || !(Date.now() - at < STORED_LIST_MAX_AGE_MS)) return;
				stored = new Map(
					live.players.flatMap((p) => (p.hiddenName ? [[p.steamId, p.hiddenName] as const] : []))
				);
			} catch (err) {
				if (err instanceof LostOwnership) throw err;
				console.warn(`[warcon] stored player list of ${serverId}:`, forLog(err));
			}
		},
		/** what these killers' texts tell them of their stats; nothing is read for none */
		stats: (wants: { steamId: string; text: string }[], sides?: { org: boolean }) =>
			statsFor(read, wants, sides),
		of: (k: KillView, stats: StatsRead, own: MessageVars): MessageVars =>
			about(k.killer!, stats, own),
		/** the same for either player of a kill, as the feed named them */
		about,
		hiddenOf,
		/** the name the other players see for a player: the hidden one, else the name given */
		shown: (steamId: string | null | undefined, name: string): string => hiddenOf(steamId) || name,
		/**
		 * The same as `about` for a text someone else will read (a broadcast): a player in anonymous
		 * mode goes by the hidden name, and what would undo it is not said: their SteamID is left
		 * blank and their stats are unknown (the boards are public, and a player's all-time kills
		 * point at one line of them).
		 */
		toOthers: (
			who: { steamId: string; name: string; faction: string | null },
			stats: StatsRead,
			own: MessageVars
		): MessageVars => {
			const hidden = hiddenOf(who.steamId);
			return hidden
				? { ...about({ ...who, name: hidden }, STATS_UNSAID, own), steamid: '' }
				: about(who, stats, own);
		}
	};
	function about(
		who: { steamId: string; name: string; faction: string | null },
		stats: StatsRead,
		own: MessageVars
	): MessageVars {
		const { server, live } = look();
		const p = live.get(who.steamId);
		return messageVars(
			server,
			{
				name: who.name || who.steamId,
				steamId: who.steamId,
				faction: who.faction ?? p?.faction ?? null,
				ping: p?.ping
			},
			statsOf(stats, who.steamId),
			own
		);
	}
}
type KillerVars = ReturnType<typeof killerVars>;

/** A player's team kills in a match by one cause (null for none) and tags, as a rule counts them. */
interface CauseCount {
	cause: string | null;
	tags: string[];
	n: number;
}

/**
 * How many team kills each of these players has in the match the batch arrived in, up to and
 * including the batch, by cause and tags: the rows that carry that match, as its match page
 * counts them. Leaving and joining again does not start the count over, and a batch acted on late
 * does not count the ones that came after it. A batch that came in while no match was open (a
 * server's first seconds, or just after its stats were purged) counts with the other such kills
 * of the hour before.
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
		.select({
			steamId: kills.killerSteamId,
			cause: kills.cause,
			tags: kills.tags,
			n: sql<number>`COUNT(*)`
		})
		.from(kills)
		.where(
			and(
				eq(kills.serverId, serverId),
				inArray(kills.killerSteamId, steamIds),
				eq(kills.teamKill, true),
				stamp?.row != null ? eq(kills.matchRow, stamp.row) : isNull(kills.matchRow),
				gte(kills.ts, match?.from ?? new Date(at.getTime() - 3600_000)),
				lte(kills.ts, at)
			)
		)
		.groupBy(kills.killerSteamId, kills.cause, kills.tags);
	const out = new Map<string, CauseCount[]>();
	for (const r of rows) {
		const list = out.get(r.steamId!) ?? out.set(r.steamId!, []).get(r.steamId!)!;
		list.push({ cause: r.cause, tags: r.tags as string[], n: Number(r.n) });
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
			for (const k of teamKills) if (countsForTeamKill(cfg, k)) byKiller.set(k.killer!.steamId, k);
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
				(n, c) => (countsForTeamKill(cfg, c) ? n + c.n : n),
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
			// the victim as the killer knows them: under the hidden name in anonymous mode
			const v = vars.of(k, stats, {
				victim: vars.shown(k.victim.steamId, k.victim.name),
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
 * The demo server's feed (kills, and Season 2's joins, leaves, match states and results), fed
 * through the same path as a real server's once its feed is turned on (Config tab): the mock has
 * no process of its own to post from, so the worker drains its queue after each observation.
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
	if (r.state || r.end) await onMatchFeed(env, memoryOf(server.id), { state: r.state, end: r.end });
}
