// The organisation's saved messages: ready-made chat lines its staff pick from wherever they type
// one (the Overview's Message to, the whisper dialogs, a player's page). Each has a name for the
// list and the text it puts in the box, sent as written. Shared by the owners' editor, the picker
// and the server's check of what an owner saves.
import { MAX_CHAT } from './chat';

export interface SavedMessage {
	/** what the list calls it */
	name: string;
	/** what it puts in the box */
	text: string;
}

export const MAX_SAVED_MESSAGES = 50;
export const MAX_SAVED_MESSAGE_NAME = 48;
/** The text's cap: the most the game takes in one chat line. */
export const MAX_SAVED_MESSAGE_TEXT = MAX_CHAT;

/**
 * One line, cut to `max` UTF-16 units as the chat boxes and the game count them, never ending on
 * half an emoji. A line break or any other control character becomes a space, and half an emoji
 * anywhere else the replacement character: Postgres refuses it in jsonb.
 */
export function oneLine(value: unknown, max: number): string {
	const text = String(value ?? '')
		.toWellFormed()
		.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ')
		.trim();
	const cut = text.slice(0, max);
	return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trim();
}

/** One message as typed or sent, each text on one line and cut to its cap. */
export function cleanSavedMessage(raw: unknown): SavedMessage {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	return {
		name: oneLine(o.name, MAX_SAVED_MESSAGE_NAME),
		text: oneLine(o.text, MAX_SAVED_MESSAGE_TEXT)
	};
}

/** What stops a list from being saved, in a sentence, or '' when nothing does. */
export function savedMessagesProblem(list: SavedMessage[]): string {
	if (list.length > MAX_SAVED_MESSAGES)
		return `An organisation keeps at most ${MAX_SAVED_MESSAGES} saved messages.`;
	if (list.some((m) => !m.name || !m.text)) return 'Each saved message needs a name and a text.';
	const names = list.map((m) => m.name.toLowerCase());
	if (new Set(names).size !== names.length) return 'Two saved messages have the same name.';
	return '';
}

/** A stored list, trusted but read defensively: anything that would not save is left out. */
export function storedSavedMessages(raw: unknown): SavedMessage[] {
	if (!Array.isArray(raw)) return [];
	const out: SavedMessage[] = [];
	for (const item of raw.slice(0, MAX_SAVED_MESSAGES)) {
		const m = cleanSavedMessage(item);
		if (!savedMessagesProblem([...out, m])) out.push(m);
	}
	return out;
}

/** The messages whose name or text holds what was typed in the picker's search, in their order. */
export function findSaved(list: SavedMessage[], query: string): SavedMessage[] {
	const q = query.trim().toLowerCase();
	return q
		? list.filter((m) => m.name.toLowerCase().includes(q) || m.text.toLowerCase().includes(q))
		: list;
}
