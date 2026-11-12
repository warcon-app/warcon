// What the game takes in one chat line. Since WARDOGS update 0.1.2 (2026-09-30) the listener caps
// the text of a whisper (POST /v1/players/{id}/message) and of a broadcast (POST /v1/broadcast).
// Kick and ban reasons are not chat and keep their own cap.

/** The longest whisper or broadcast the game takes. */
export const MAX_CHAT = 256;

// What players say, as Season 3 (CL-533689) serves it from GET /v1/chat: the current map's lines
// only, held in the game's memory and numbered from 1 again when a map loads (docs/wardogs-api.md).

/** One line of in-game chat, in the fields the `chat` action keeps. */
export interface ChatMessage {
	seq: number;
	sentUtc: string;
	/** `Team` or `Global` */
	channel: string;
	faction: string;
	steamId: string;
	realName: string;
	/** the anonymised name other players see */
	hiddenName: string;
	anonymous: boolean;
	text: string;
	rawText: string;
}

export interface ChatPage {
	latestSeq: number;
	messages: ChatMessage[];
}

/** Bulkhead's terms for reading chat, which an admin accepts once per server and version. */
export interface ChatTerms {
	requiredVersion: number;
	acceptedVersion: number;
	accepted: boolean;
	text: string;
}

/**
 * The `after` to ask for next: one before the last line held, so the answer starts with that line
 * again and mergeChat can tell the same map from a new one.
 */
export const chatAfter = (lines: ChatMessage[]): number =>
	Math.max(0, (lines.at(-1)?.seq ?? 0) - 1);

/**
 * The lines held plus what a read with `after = chatAfter(lines)` brought, or null when the map
 * has changed underneath (the numbering went down, or the line held last is not where it was), in
 * which case the caller reads again from 0. Checking the line and not only the number also
 * catches a new map that got past the old one's count while nobody was looking.
 */
export function mergeChat(lines: ChatMessage[], page: ChatPage): ChatMessage[] | null {
	const last = lines.at(-1);
	if (!last) return page.messages;
	const [anchor, ...rest] = page.messages;
	if (
		page.latestSeq < last.seq ||
		!anchor ||
		anchor.seq !== last.seq ||
		anchor.sentUtc !== last.sentUtc ||
		anchor.steamId !== last.steamId
	)
		return null;
	return rest.length ? [...lines, ...rest] : lines;
}
