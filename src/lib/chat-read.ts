// Season 3's in-game chat over RCON, as the panel reads it: the terms a server sets on its chat
// (and on its event feed, which sends nothing until they are accepted) and the chat lines
// themselves, each kept to the fields below. The lines are players' messages, shown to the people
// who moderate a server under those terms. They go from the game to the reader's page and are kept
// nowhere: no table, no audit detail, no webhook, no worker memory. The worker reads them as well,
// on a server with a chat rule switched on, to answer the lines that are commands of that server
// (server/chat-look.ts): it holds no line between two reads, and what a player sends staff through
// a Staff call is the one thing passed on, to the organisation's own Discord.
//
// Shapes from the official console's Season 3 client and its field notes (2026-11-12); not yet seen
// on a live server:
//   GET  /v1/chat/terms            { requiredVersion, acceptedVersion, accepted, text }
//   POST /v1/chat/terms {version}  { ok, pending, message }; 400 terms_version_mismatch, 400 missing_version
//   GET  /v1/chat?after=SEQ&limit=N  { latestSeq, messages: [...], count }; 409 chat_terms_not_accepted
//   a message: { seq, sentUtc, channel, faction, steamId, realName, hiddenName, anonymous, text,
//                rawText, ping }

export interface ChatTerms {
	/** the version of the terms the server asks for */
	requiredVersion: number;
	/** the version accepted on it; 0 when none has been */
	acceptedVersion: number;
	accepted: boolean;
	/** the terms in the server's own words: plain text, a line a paragraph, "- " a list item */
	text: string;
	/** the server sent more text than is kept here: what is shown is not the whole of its terms */
	cut: boolean;
}

export interface ChatLine {
	/** the game's running number: a read asks for what came after the last one it has */
	seq: number;
	/** when it was sent (ISO); null when the game gave nothing that reads as a time */
	at: string | null;
	/** Team, Global, Squad, Proximity, Vehicle; kept as the game names it */
	channel: string;
	faction: string;
	/** '' for a player the game gives no platform id */
	steamId: string;
	/** the player's own name */
	name: string;
	/** the generated name every player has ("Amber Falcon"); '' when the game sent none */
	hiddenName: string;
	/** anonymous mode: other players see only the hidden name */
	anonymous: boolean;
	/** as players saw it, after the game's chat filter */
	text: string;
	/** as it was typed, when the filter changed it; null when it did not */
	typed: string | null;
	/** a ping callout ("Attack here") rather than typed chat */
	ping: boolean;
}

export interface ChatRead {
	/**
	 * The newest line's number on the server, as the game gives it; null when it gives none. Below
	 * the last number read, it says the game has started numbering again (a new process).
	 */
	latestSeq: number | null;
	/** oldest first, each number once */
	lines: ChatLine[];
}

/** What a Chat tab holds: its lines newest first, and the number of the newest one it has read. */
export interface ChatHeld {
	lines: ChatLine[];
	latest: number;
}

/** The most asked for in a read: the official console's demo keeps 500 lines and gives at most
 * that many at a time (a real server's own figures have not been seen). */
export const CHAT_MAX_LIMIT = 500;
/** What the Chat tab asks for at a time. */
export const CHAT_PAGE = 200;
/** Lines a Chat tab holds; older ones fall off. */
export const CHAT_KEEP = 1000;
/** Far past any terms seen (the console's bundled ones are 600 characters); longer is marked cut. */
const MAX_TERMS_TEXT = 20_000;
const MAX_TEXT = 500;
const MAX_NAME = 64;
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

const whole = (v: unknown, max = MAX_SEQ): number =>
	typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0;

/** A line's number: a whole number above 0, as a number or as digits in a string; else 0. */
const seqOf = (v: unknown): number =>
	whole(typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : v);

/** One line of text: control characters and line or paragraph separators become spaces. */
const line = (v: unknown, max: number): string =>
	typeof v === 'string'
		? v
				.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
				.trim()
				.slice(0, max)
		: '';

/** The server's answer about its terms, kept to its four fields; null when it is not one. */
export function chatTermsOf(raw: unknown): ChatTerms | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	// The version asked for is what makes this a terms answer. A server that asks for none (0) is
	// taken at its word: its real answers have not been seen, and reading too strictly here would
	// shut the tab on a server that serves its chat.
	const required = o.requiredVersion;
	if (typeof required !== 'number' || !Number.isInteger(required) || required < 0) return null;
	const requiredVersion = whole(required, 1_000_000);
	const acceptedVersion = whole(o.acceptedVersion, 1_000_000);
	// line breaks kept (the terms are paragraphs and list items), other control characters dropped
	const text =
		typeof o.text === 'string'
			? o.text
					.replace(/\r\n?|[\p{Zl}\p{Zp}]/gu, '\n')
					.replace(/[^\P{Cc}\n]/gu, '')
					.trim()
			: '';
	return {
		requiredVersion,
		acceptedVersion,
		// the game's own word where it gives one; else what the two versions say
		accepted: typeof o.accepted === 'boolean' ? o.accepted : acceptedVersion >= requiredVersion,
		text: text.slice(0, MAX_TERMS_TEXT),
		cut: text.length > MAX_TERMS_TEXT
	};
}

function chatLineOf(raw: unknown): ChatLine | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const seq = seqOf(o.seq);
	if (!seq) return null;
	const sent = typeof o.sentUtc === 'string' ? Date.parse(o.sentUtc) : NaN;
	const text = line(o.text, MAX_TEXT);
	const typed = line(o.rawText, MAX_TEXT);
	return {
		seq,
		at: Number.isFinite(sent) ? new Date(sent).toISOString() : null,
		channel: line(o.channel, 24),
		faction: line(o.faction, 24),
		steamId: typeof o.steamId === 'string' && /^\d{17}$/.test(o.steamId) ? o.steamId : '',
		name: line(o.realName, MAX_NAME),
		hiddenName: line(o.hiddenName, MAX_NAME),
		anonymous: o.anonymous === true,
		text,
		typed: typed && typed !== text ? typed : null,
		ping: o.ping === true
	};
}

/** The server's answer to a chat read, oldest line first; null when it is not one. */
export function chatReadOf(raw: unknown): ChatRead | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	// An answer that numbers its newest line and lists none is a read with nothing new.
	const messages = Array.isArray(o.messages)
		? o.messages
		: o.messages == null && typeof o.latestSeq === 'number'
			? []
			: null;
	if (!messages) return null;
	const seen = new Set<number>();
	const lines = messages
		.slice(0, CHAT_MAX_LIMIT)
		.map(chatLineOf)
		// a number once: a page keys its rows by it
		.filter((l): l is ChatLine => !!l && !seen.has(l.seq) && !!seen.add(l.seq))
		.sort((a, b) => a.seq - b.seq);
	// A list with entries and not one line among them is some other answer, not a quiet chat.
	if (messages.length && !lines.length) return null;
	const given = o.latestSeq;
	return {
		latestSeq:
			typeof given === 'number' && Number.isInteger(given) && given >= 0 ? whole(given) : null,
		lines
	};
}

/**
 * Takes a read into what a tab holds. `restarted`: the game is numbering from the start again
 * (the official console's rule: its newest number is below the last one read), so what was held
 * is dropped and the read is to be made again from 0. `more`: a full page of new lines came, so
 * another may be waiting.
 */
export function takeRead(
	held: ChatHeld,
	read: ChatRead,
	page = CHAT_PAGE,
	keep = CHAT_KEEP
): ChatHeld & { restarted: boolean; more: boolean } {
	if (read.latestSeq !== null && read.latestSeq < held.latest)
		return { lines: [], latest: 0, restarted: true, more: true };
	const fresh = read.lines.filter((l) => l.seq > held.latest);
	if (!fresh.length) return { ...held, restarted: false, more: false };
	const lines = [...fresh.reverse(), ...held.lines].slice(0, keep);
	return { lines, latest: lines[0].seq, restarted: false, more: read.lines.length >= page };
}

/** The name the other players saw on a line: the hidden one in anonymous mode. */
export const shownName = (l: Pick<ChatLine, 'name' | 'hiddenName' | 'anonymous'>): string =>
	(l.anonymous && l.hiddenName ? l.hiddenName : l.name) || l.hiddenName || 'Unknown';

/**
 * The terms as blocks for a page: a line a paragraph, a run of "- " or "* " lines a list. Text
 * only: nothing in it is markup.
 */
export function termsBlocks(text: string): ({ p: string } | { ul: string[] })[] {
	const out: ({ p: string } | { ul: string[] })[] = [];
	let list: string[] | null = null;
	for (const raw of text.split('\n')) {
		const t = raw.trim();
		if (!t) {
			list = null;
			continue;
		}
		const item = /^[-*]\s+(.*)$/.exec(t);
		if (item) {
			if (!list) {
				list = [];
				out.push({ ul: list });
			}
			list.push(item[1]);
		} else {
			list = null;
			out.push({ p: t });
		}
	}
	return out;
}
