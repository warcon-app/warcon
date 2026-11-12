// The worker's own reading of the in-game chat, for the chat rules (chat-rules.ts). On a server
// that has a chat rule switched on, and on no other, the worker reads the chat after its look at
// the server, a few seconds apart, and answers the lines that are commands of that server: a Chat
// command's reply goes out as a whisper or a broadcast, a Staff call goes to the organisation's
// Discord. Everything is sent in the same look, through the lane the look already holds.
//
// What players type is theirs, read under the game's chat terms. So:
//   - a line that is not a command of this server is dropped where it is read: no log line, no
//     event, no counter;
//   - nothing typed is stored: no table, no outbox row, no audit row. A rule's row keeps how often
//     it answered and when, never who or what. A staff call's text goes to the organisation's own
//     Discord, which the player asked for, and nowhere else;
//   - the worker holds no line between looks: only the number of the last one it read, and when
//     each rule last answered whom. (A staff call's card waits a moment in the webhook's queue,
//     in memory, until Discord takes it.)
// The number of the last line is not always to be trusted (a worker that has just started or taken
// over, a rule just switched on, a server back from an outage or a restart, a game that numbers
// from the start again, a read that came late, a page so full that it is a backlog): then the place
// is found again before anything is acted on, from the game's own word of its newest line and a
// read from there that brings nothing. Nothing typed before the place was found is acted on, and a
// game whose word cannot be so (none, or a number below a line it sends) has its chat counted as
// unreadable, which the rules' rows say. A command is answered at once or never; never late, never
// twice.
import { eq, sql } from 'drizzle-orm';
import type { Env } from './env';
import type { ServerRow } from './access';
import { ACTIONS, readChat } from './actions';
import { forLog } from './http';
import { GameError, type WardogsClient } from './rcon';
import { triggers, type TriggerRow } from './db/schema';
import { isOwner, LostOwnership, withOwnedTransaction } from './leadership';
import { settings } from './settings';
import { chatAnswers, chatReads } from './metrics';
import { chatRulesAmong, renderTemplate, statsFor, statsOf, statsReader } from './triggers';
import { keptVars, messageVars, serverVars, UNKNOWN, type MessageVars } from './message-vars';
import {
	CHAT_WAIT_WORDS,
	WAITING,
	chatStep,
	listedWords,
	newChatTracks,
	pruneChatTracks,
	repliesUse,
	rotationVars,
	sendsLeft,
	teamsLine,
	topLine,
	wordsOf,
	type ChatAct,
	type ChatCommandConfig,
	type ChatRule,
	type ChatRuleState,
	type ChatTracks,
	type ChatWait
} from './chat-rules';
import { notifyStaffCall } from './webhook-delivery';
import { loadBoard, rankOf } from './leaderboards';
import { DEFAULT_BOARD_QUERY } from '$lib/leaderboard';
import { MAX_CHAT } from '$lib/chat';
import { CHAT_PAGE, type ChatRead } from '$lib/chat-read';
import { COMMAND_PREFIX, commandsLine, namedPlayer, NOT_ANSWERED } from '$lib/chat-commands';
import type { Features, Player, Rotation, Status } from '$lib/types';

/** A read is this much less than a request usually gets: the route is new, and a slow one must not
 *  hold the look. */
const READ_TIMEOUT_MS = 3000;
/**
 * A read this long after the last one finds the place again and acts on nothing in between; longer
 * where the site reads the chat, or looks at its servers, less often than every few seconds.
 */
export const CHAT_STALE_MS = 15_000;
/** Reads one look spends on finding the place: the game's newest number, then that nothing follows. */
const FIND_READS = 3;
/** The place not found in this many reads, the chat counts as unreadable: its numbers have no end. */
const FIND_GIVE_UP = 12;
/** A game start this much later than the one read under is a restart (as in observe.ts). */
const NEW_START_MS = 60_000;
/** Asked again this often while the game's chat terms wait to be accepted. */
const TERMS_WAIT_MS = 60_000;
/** The longest wait between two tries while the read fails. */
const MAX_BACKOFF_MS = 60_000;
/** The rules' rows are told the read fails once it has failed this many times in a row. */
const FAILING_AFTER = 3;
/** A look that comes a moment before the interval is up still reads. */
const SLACK_MS = 250;
/** A rule's row is written at most this often while it answers. */
export const CHAT_FLUSH_MS = 60_000;
const PRUNE_MS = 60_000;
const ROTATION_TTL_MS = 60_000;
const TOP_TTL_MS = 60_000;
const RANK_TTL_MS = 5 * 60_000;

/** What a reply said to everyone calls a player in anonymous mode the game gave no other name. */
const NO_NAME = 'A player';

const NO_HOOK =
	'No working Discord webhook takes Staff calls for this server: under Organisation → Webhooks, tick the box on one, or mend the one Discord refuses.';

/** What the worker remembers of one server's chat between looks: a place and times, never a line. */
export interface ChatMemory {
	/** the number of the last line read; what comes after it is new */
	cursor: number;
	/** the place is found: a read from it brought nothing, so lines after it are acted on */
	primed: boolean;
	/** reads spent on finding the place since it was last found, or last given up on */
	finding: number;
	/** when the chat was last read; 0 before the first read */
	readAt: number;
	/** no read before this: the terms wait, or the read failed and waits longer each time */
	waitUntil: number;
	failures: number;
	/** the game start the place was read under; 0 while unknown */
	startedAt: number;
	tracks: ChatTracks;
	/** what each rule's row was last told it waits for; a rule not in it has been told nothing */
	told: Map<string, ChatWait>;
	/** each rule's answers (a Staff call's calls) since its row was last written, and the last
	 *  thing that went wrong */
	counts: Map<string, { n: number; at: number; failed: string; calls: boolean }>;
	flushedAt: number;
	prunedAt: number;
	rotation: { at: number; entries: Rotation['entries']; nextIndex: number } | null;
	top: { at: number; line: string } | null;
	ranks: Map<string, { at: number; rank: string }>;
}

const memories = new Map<string, ChatMemory>();

const fresh = (now: number): ChatMemory => ({
	cursor: 0,
	primed: false,
	finding: 0,
	readAt: 0,
	waitUntil: 0,
	failures: 0,
	startedAt: 0,
	tracks: newChatTracks(),
	told: new Map(),
	counts: new Map(),
	flushedAt: 0,
	prunedAt: now,
	rotation: null,
	top: null,
	ranks: new Map()
});

/** Forgets the chat memory of one server (gone from the worker), or of every server (a new period
 *  of ownership: another worker may have read on since). */
export function forgetChat(serverId?: string): void {
	if (serverId) memories.delete(serverId);
	else memories.clear();
}

/** The chat memory of a server, for the tests. */
export const chatMemoryOf = (serverId: string): ChatMemory | undefined => memories.get(serverId);

/** Whether the look at this server would read its chat: it has a chat rule on. */
export const readsChat = (rows: readonly TriggerRow[]): boolean => chatRulesAmong(rows).length > 0;

/** One look, as far as the chat rules need it. */
export interface ChatLook {
	server: ServerRow;
	status: Status | null;
	players: Player[];
	/** when the game process started (ms); 0 while unknown */
	startedAt: number;
	/** what the build serves; null until the worker has read it */
	features: Features | null;
	/** the server's enabled rules, of every kind */
	rows: readonly TriggerRow[];
	/** the server's organisation is suspended: its people cannot see or change the rules */
	suspended: boolean;
	/** how often the worker looks at the server as it stands (ms): a read comes no sooner */
	everyMs: number;
	client: WardogsClient;
	now: number;
}

export interface ChatLookResult {
	/** the game asked the panel to slow down: no look for this long (0: it did not) */
	retryAfterMs: number;
}

const NONE: ChatLookResult = { retryAfterMs: 0 };

/**
 * Reads the chat if the server has a chat rule on (and its organisation is not suspended), players
 * on, a build that serves the chat and a read is due, and answers what it finds. A failure here is
 * the chat's own: the look it follows has already been written and stands. Never throws but for a
 * lost lease.
 */
export async function keepChat(env: Env, look: ChatLook): Promise<ChatLookResult> {
	const id = look.server.id;
	const rules = chatRulesAmong(look.rows);
	if (!rules.length || look.suspended) {
		// No rule, no reading, and nothing remembered: one switched on later starts from a new place.
		// Nor is the chat read for an organisation that is suspended: nobody of it can see the rules
		// or switch them off, and its players' chat is not the panel's to read on its own.
		memories.delete(id);
		return NONE;
	}
	if (!isOwner()) return NONE;
	const now = look.now;
	let mem = memories.get(id);
	if (!mem) memories.set(id, (mem = fresh(now)));
	if (!look.features) return NONE;
	if (!look.features.chat) {
		await tellWait(env, mem, rules, 'build');
		return NONE;
	}
	// nobody on, nobody typing
	const on = Math.max(look.status?.playerCount ?? 0, look.players.length);
	if (!on) return NONE;
	if (now < mem.waitUntil || now - mem.readAt < settings().chatMs - SLACK_MS) return NONE;

	// A place read too long ago, or under another start of the game, is no place to go on from,
	// found or half found. Too long is measured by how often a read comes at all.
	const staleAfter = Math.max(CHAT_STALE_MS, 2 * Math.max(settings().chatMs, look.everyMs) + 1000);
	const restarted =
		look.startedAt > 0 && mem.startedAt > 0 && look.startedAt - mem.startedAt > NEW_START_MS;
	if (now - mem.readAt > staleAfter || restarted) lose(mem);
	if (look.startedAt) mem.startedAt = look.startedAt;

	if (!mem.primed) return findPlace(env, look, mem, rules);

	let read: ChatRead;
	try {
		read = await readChat(look.client, mem.cursor, CHAT_PAGE, READ_TIMEOUT_MS);
	} catch (err) {
		return readFailed(env, look.server, mem, rules, err, now);
	}
	if (read.latestSeq === null) return readFailed(env, look.server, mem, rules, noPlace(), now);
	chatReads.inc({ outcome: 'ok' });
	mem.failures = 0;
	mem.waitUntil = 0;
	mem.readAt = now;
	await tellWait(env, mem, rules, '');

	const lines = read.lines.filter((l) => l.seq > mem.cursor);
	// The game numbers from the start again (its newest line is below the place), or sends a page
	// full: more than players type between two reads, so a backlog. Either way the place is lost,
	// and what the read brought was typed before it is found again.
	if (read.latestSeq < mem.cursor || lines.length >= CHAT_PAGE) {
		lose(mem);
		return NONE;
	}
	if (lines.length) mem.cursor = lines[lines.length - 1].seq;

	if (now - mem.prunedAt >= PRUNE_MS) {
		mem.prunedAt = now;
		pruneChatTracks(mem.tracks, rules, now);
		for (const [steamId, r] of mem.ranks) if (now - r.at >= RANK_TTL_MS) mem.ranks.delete(steamId);
	}
	const { acts } = chatStep(wordsOf(rules), mem.tracks, lines, now, sendsLeft(mem.tracks, now));
	const result = acts.length ? await perform(env, look, mem, rules, acts, on) : NONE;
	await flushCounts(env, mem, now);
	return result;
}

/** The place is lost: nothing is acted on until it is found again, from the start. */
function lose(mem: ChatMemory): void {
	mem.primed = false;
	mem.cursor = 0;
}

/** A read that answered, and said nothing the place can be found by. */
const noPlace = (): GameError =>
	new GameError(502, 'The server did not say where its chat stands.', 'bad_response');

/**
 * Finds where the chat stands, and acts on nothing it reads on the way. One line is read from the
 * start for the game's word of its newest line; then the chat is read from that number, and the
 * place is found once such a read brings nothing after it. A read that does bring lines (typed in
 * between, or a game whose word was of something else) moves the place on and is made again, a few
 * times in a look and then at the next. A game that gives no newest line, or one below a line it
 * sends, cannot be placed: its read counts as failed, as does a chat whose end never comes.
 */
async function findPlace(
	env: Env,
	look: ChatLook,
	mem: ChatMemory,
	rules: ChatRule[]
): Promise<ChatLookResult> {
	const { now } = look;
	for (let i = 0; i < FIND_READS; i++) {
		if (!isOwner()) return NONE;
		let read: ChatRead;
		try {
			read = await readChat(look.client, mem.cursor, mem.cursor ? CHAT_PAGE : 1, READ_TIMEOUT_MS);
		} catch (err) {
			return readFailed(env, look.server, mem, rules, err, now);
		}
		const latest = read.latestSeq;
		const last = read.lines.at(-1)?.seq ?? 0;
		if (latest === null || latest < last || ++mem.finding > FIND_GIVE_UP) {
			mem.finding = 0;
			lose(mem);
			return readFailed(env, look.server, mem, rules, noPlace(), now);
		}
		chatReads.inc({ outcome: 'ok' });
		mem.waitUntil = 0;
		mem.readAt = now;
		if (latest < mem.cursor) {
			// it numbers from the start again: so does the finding
			mem.cursor = 0;
			continue;
		}
		const more = read.lines.some((l) => l.seq > mem.cursor);
		mem.cursor = latest;
		if (more) continue;
		mem.primed = true;
		mem.finding = 0;
		mem.failures = 0;
		await tellWait(env, mem, rules, '');
		break;
	}
	return NONE;
}

/** A failed game request as the log has it: its status and its code. */
const statusAndCode = (g: GameError): string => `${g.status} ${g.code}`.trim();

/**
 * A read of the chat failed. The game asking the panel to slow down holds the server, as it does
 * for any request. Chat terms not accepted, or a route the build does not serve after all, is said
 * on the rules' rows and asked again now and then. Anything else is tried again, twice as long
 * after each failure up to a minute. The place is left as it was: a short lapse goes on from it,
 * and after a longer one (every wait for the terms is one) it is too old to hold (keepChat), so
 * what was typed while the chat could not be read is not acted on once it can.
 */
async function readFailed(
	env: Env,
	server: ServerRow,
	mem: ChatMemory,
	rules: ChatRule[],
	err: unknown,
	now: number
): Promise<ChatLookResult> {
	if (err instanceof LostOwnership) throw err;
	const code = err instanceof GameError ? err.code : '';
	if (code === 'rate_limited') {
		chatReads.inc({ outcome: 'held' });
		const retryAfterMs = (err as GameError).retryAfterMs || 5000;
		mem.waitUntil = now + retryAfterMs;
		return { retryAfterMs };
	}
	chatReads.inc({
		outcome: code === 'chat_terms_not_accepted' || code === 'no_route' ? 'waiting' : 'failed'
	});
	if (code === 'chat_terms_not_accepted') {
		mem.waitUntil = now + TERMS_WAIT_MS;
		await tellWait(env, mem, rules, 'terms');
		return NONE;
	}
	if (code === 'no_route') {
		// the build listed the route and does not serve it: asked again now and then
		mem.waitUntil = now + 10 * TERMS_WAIT_MS;
		await tellWait(env, mem, rules, 'build');
		return NONE;
	}
	mem.failures++;
	mem.waitUntil =
		now + Math.min(MAX_BACKOFF_MS, settings().chatMs * 2 ** Math.min(mem.failures, 10));
	// the game's status and code, never its message
	if (mem.failures === 1)
		console.warn(
			`[warcon] chat of ${server.name} not read:`,
			err instanceof GameError ? statusAndCode(err) : forLog(err)
		);
	if (mem.failures >= FAILING_AFTER) await tellWait(env, mem, rules, 'failing');
	return NONE;
}

/**
 * Says on each of the server's chat rules what it waits for, once per rule each time it changes: a
 * rule added while the others wait is told too. With nothing to wait for, a rule this worker never
 * told to wait keeps its last result, unless that is a wait an earlier worker left there.
 */
async function tellWait(
	env: Env,
	mem: ChatMemory,
	rules: ChatRule[],
	wait: ChatWait
): Promise<void> {
	const due = rules.filter((r) => mem.told.get(r.id) !== wait);
	if (!due.length) return;
	const before = new Map(due.map((r) => [r.id, mem.told.get(r.id)]));
	for (const r of due) mem.told.set(r.id, wait);
	if (mem.told.size > rules.length) {
		const live = new Set(rules.map((r) => r.id));
		for (const id of mem.told.keys()) if (!live.has(id)) mem.told.delete(id);
	}
	try {
		await withOwnedTransaction(env, async (tx) => {
			for (const rule of due)
				await tx
					.update(triggers)
					.set({
						state: { wait } satisfies ChatRuleState,
						lastResult:
							wait || before.get(rule.id)
								? CHAT_WAIT_WORDS[wait]
								: sql`case when ${triggers.lastResult} like ${WAITING + '%'} then ${CHAT_WAIT_WORDS['']} else ${triggers.lastResult} end`
					})
					.where(eq(triggers.id, rule.id));
		});
	} catch (err) {
		if (err instanceof LostOwnership) throw err;
		// told again at the next look
		for (const r of due) {
			const was = before.get(r.id);
			if (was === undefined) mem.told.delete(r.id);
			else mem.told.set(r.id, was);
		}
		console.warn('[warcon] chat rules not told what they wait for:', forLog(err));
	}
}

/** A failed send as a rule's row words it: the game's status and code, never its message. */
function sendRefusal(err: unknown): string {
	if (!(err instanceof GameError)) {
		console.warn('[warcon] a chat rule could not answer:', forLog(err));
		return `${NOT_ANSWERED}: the panel could not send it.`;
	}
	if (err.code === 'rate_limited')
		return `${NOT_ANSWERED}: the server asked the panel to slow down.`;
	return `${NOT_ANSWERED}: refused by the server (${err.status}${/^[a-z_]{1,40}$/.test(err.code) ? `, ${err.code}` : ''}).`;
}

/** The player left between typing and the answer: nothing went wrong. */
const gone = (err: unknown): boolean =>
	err instanceof GameError && err.status === 404 && err.code !== 'no_route';

/** Does what the step decided, in order: whispers, broadcasts and staff calls. */
async function perform(
	env: Env,
	look: ChatLook,
	mem: ChatMemory,
	rules: ChatRule[],
	acts: ChatAct[],
	on: number
): Promise<ChatLookResult> {
	const { server, client, now } = look;
	const serverName = look.status?.serverName || server.name;
	const listed = new Map(look.players.map((p) => [p.steamId, p]));
	const base = serverVars({
		name: server.name,
		status: look.status,
		startedAt: look.startedAt,
		now
	});
	const read = statsReader(env, server.id);
	let retryAfterMs = 0;
	/** the game stopped answering, or failed on its own: nothing more is sent to it in this look */
	let stopped = false;
	const tally = (rule: ChatRule) => {
		let c = mem.counts.get(rule.id);
		if (!c)
			mem.counts.set(
				rule.id,
				(c = { n: 0, at: now, failed: '', calls: rule.kind === 'staff_call' })
			);
		return c;
	};
	/** One message to the game; false when it did not go. */
	const send = async (rule: ChatRule, go: () => Promise<unknown>): Promise<boolean> => {
		if (retryAfterMs || stopped || !isOwner()) return false;
		mem.tracks.sent.push(Date.now());
		try {
			await go();
			return true;
		} catch (err) {
			if (err instanceof LostOwnership) throw err;
			if (gone(err)) return false;
			if (err instanceof GameError && err.code === 'rate_limited')
				retryAfterMs = err.retryAfterMs || 5000;
			// no answer, or the game's own failure: the next send would wait as long for the same
			else if (!(err instanceof GameError) || err.status >= 500) stopped = true;
			tally(rule).failed = sendRefusal(err);
			return false;
		}
	};
	const whisper = (rule: ChatRule, steamId: string, message: string) =>
		message
			? send(rule, () => ACTIONS.whisper.run(client, { steamId, message }))
			: Promise.resolve(false);
	/** callers whose call reached nobody in this look, by rule and SteamID */
	const unheard = new Set<string>();

	for (const act of acts) {
		if (!isOwner()) break;
		// The game is taking no more messages in this look: what is left unanswered stays so. A call
		// to staff still goes to Discord, which does not wait on the game; its whisper back does not.
		if ((retryAfterMs || stopped) && act.type !== 'call') continue;
		const { rule, line } = act;
		const steamId = line.steamId;
		const p = listed.get(steamId);
		// the player as the server lists them; the line's own name until the list has them
		const player = {
			name: p?.name || line.name || steamId,
			steamId,
			faction: p?.faction ?? null,
			ping: p?.ping
		};
		if (act.type === 'reply') {
			const cfg = act.cfg;
			const said = cfg.to === 'everyone';
			// Said to everyone, nothing tells the server who a player in anonymous mode is: they go by
			// the name the others see (or by none the game gave), and their SteamID, ping, stats and
			// rank are not said. Nobody's stats across the organisation are said to everyone.
			const hidden = said && line.anonymous;
			const about = hidden
				? { name: line.hiddenName || NO_NAME, steamId: '', faction: player.faction, ping: null }
				: player;
			const stats = hidden
				? {}
				: statsOf(
						await statsFor(
							read,
							cfg.replies.map((text) => ({ steamId, text })),
							{ org: !said }
						),
						steamId
					);
			const own = await ownVars(env, look, mem, rules, cfg, hidden ? '' : steamId);
			const all = messageVars(base, about, stats, own);
			const vars = said ? keptVars(all) : all;
			let sent = 0;
			for (const reply of cfg.replies) {
				const message = renderTemplate(reply, vars, MAX_CHAT).trim();
				if (!message) continue;
				const went = said
					? await send(rule, () => ACTIONS.broadcast.run(client, { message }))
					: await whisper(rule, steamId, message);
				if (!went) break;
				sent++;
			}
			if (sent) {
				const c = tally(rule);
				c.n++;
				c.at = now;
				chatAnswers.inc({ kind: rule.kind });
			}
			continue;
		}
		const vars = (seconds: number | string) =>
			messageVars(
				base,
				player,
				{},
				{
					command: COMMAND_PREFIX + act.word,
					seconds
				}
			);
		if (act.type === 'usage') {
			await whisper(rule, steamId, renderTemplate(act.cfg.usage, vars(''), MAX_CHAT).trim());
			continue;
		}
		if (act.type === 'wait') {
			// their call a moment ago in this read reached nobody: they are not told it was passed on
			if (unheard.has(`${rule.id} ${steamId}`)) continue;
			await whisper(
				rule,
				steamId,
				renderTemplate(act.cfg.wait, vars(act.seconds), MAX_CHAT).trim()
			);
			continue;
		}
		// A report names its player first: looked up among those on, never the caller.
		const named = act.report ? namedPlayer(act.rest, look.players, steamId) : null;
		const taken = await notifyStaffCall(
			env,
			{ id: server.id, orgId: server.orgId, name: serverName },
			{
				at: new Date(now).toISOString(),
				word: act.word,
				report: act.report,
				text: act.rest,
				channel: line.channel,
				caller: {
					steamId,
					name: player.name,
					hiddenName: line.hiddenName,
					anonymous: line.anonymous
				},
				about: named
					? { steamId: named.player.steamId, name: named.player.name, guess: named.guess }
					: null,
				map: look.status?.map ?? '',
				players: on
			}
		);
		const c = tally(rule);
		if (!taken) {
			// nobody was told, so the player is not told that staff were; they may call again at once
			c.failed = NO_HOOK;
			mem.tracks.players.get(rule.id)?.delete(steamId);
			unheard.add(`${rule.id} ${steamId}`);
			continue;
		}
		c.n++;
		c.at = now;
		c.failed = '';
		chatAnswers.inc({ kind: rule.kind });
		if (act.ack)
			await whisper(rule, steamId, renderTemplate(act.cfg.ack, vars(''), MAX_CHAT).trim());
	}
	return { retryAfterMs };
}

/** A Chat command's own placeholders, each worked out only when its replies name it. `steamId` is
 *  '' for a player whose place on the board is not to be said. */
async function ownVars(
	env: Env,
	look: ChatLook,
	mem: ChatMemory,
	rules: ChatRule[],
	cfg: ChatCommandConfig,
	steamId: string
): Promise<MessageVars> {
	const uses = repliesUse(cfg);
	const own: MessageVars = {};
	if (uses.has('commands')) own.commands = commandsLine(listedWords(rules));
	if (uses.has('teams'))
		own.teams = teamsLine(look.players, look.status?.scores.map((f) => f.name) ?? []);
	if (uses.has('next_map') || uses.has('rotation')) Object.assign(own, await rotationOf(look, mem));
	if (uses.has('rank')) own.rank = steamId ? await rankFor(env, look, mem, steamId) : UNKNOWN;
	if (uses.has('top')) own.top = await topFor(env, look, mem);
	return own;
}

/** The server's rotation, read from the game at most once a minute and only for a reply that
 *  names it; what is up next comes with every status look. */
async function rotationOf(
	look: ChatLook,
	mem: ChatMemory
): Promise<{ next_map: string; rotation: string }> {
	const { now } = look;
	if (!mem.rotation || now - mem.rotation.at >= ROTATION_TTL_MS) {
		try {
			const r = (await ACTIONS.rotation.run(look.client, {})) as Rotation;
			mem.rotation = { at: now, entries: r.entries, nextIndex: r.nextIndex };
		} catch (err) {
			if (err instanceof LostOwnership) throw err;
			// what was read before stands another minute; with nothing read, the names are unknown
			mem.rotation = {
				at: now,
				entries: mem.rotation?.entries ?? [],
				nextIndex: mem.rotation?.nextIndex ?? -1
			};
		}
	}
	const next = look.status && look.status.rotationNext >= 0 ? look.status.rotationNext : -1;
	return rotationVars(mem.rotation.entries, next >= 0 ? next : mem.rotation.nextIndex);
}

/** The player's place on this server's all-time board by kills; "unranked" under its playtime floor. */
async function rankFor(
	env: Env,
	look: ChatLook,
	mem: ChatMemory,
	steamId: string
): Promise<string> {
	const known = mem.ranks.get(steamId);
	if (known && look.now - known.at < RANK_TTL_MS) return known.rank;
	let rank = UNKNOWN;
	try {
		const place = await rankOf(env, [look.server.id], steamId);
		rank = place === null ? 'unranked' : String(place);
	} catch (err) {
		console.warn(`[warcon] chat rules, a rank on ${look.server.id}:`, forLog(err));
	}
	mem.ranks.set(steamId, { at: look.now, rank });
	return rank;
}

/** The first three of this server's all-time board by kills. */
async function topFor(env: Env, look: ChatLook, mem: ChatMemory): Promise<string> {
	if (mem.top && look.now - mem.top.at < TOP_TTL_MS) return mem.top.line;
	let line = UNKNOWN;
	try {
		const board = await loadBoard(
			env,
			[look.server.id],
			{ ...DEFAULT_BOARD_QUERY, range: 'all' },
			look.server.orgId
		);
		line = topLine(board.rows);
	} catch (err) {
		console.warn(`[warcon] chat rules, the board of ${look.server.id}:`, forLog(err));
	}
	mem.top = { at: look.now, line };
	return line;
}

/**
 * Writes on each rule's row how often it answered since the last write and when, or the last thing
 * that went wrong: at once after a quiet minute, then at most once a minute. Counts only.
 */
async function flushCounts(env: Env, mem: ChatMemory, now: number): Promise<void> {
	if (!mem.counts.size || now - mem.flushedAt < CHAT_FLUSH_MS) return;
	const counts = mem.counts;
	mem.counts = new Map();
	mem.flushedAt = now;
	try {
		await withOwnedTransaction(env, async (tx) => {
			for (const [ruleId, c] of counts) {
				if (!c.n && !c.failed) continue;
				await tx
					.update(triggers)
					.set({
						...(c.n
							? { lastFiredAt: new Date(c.at), fireCount: sql`${triggers.fireCount} + ${c.n}` }
							: {}),
						lastResult:
							c.failed ||
							(c.calls
								? `Passed ${c.n === 1 ? 'a call' : `${c.n} calls`} on to Discord.`
								: `Answered ${c.n === 1 ? 'once' : `${c.n} times`}.`)
					})
					.where(eq(triggers.id, ruleId));
			}
		});
	} catch (err) {
		if (err instanceof LostOwnership) throw err;
		// they were counts: the next ones are written in their turn
		console.warn('[warcon] chat rules, their rows not written:', forLog(err));
	}
}
