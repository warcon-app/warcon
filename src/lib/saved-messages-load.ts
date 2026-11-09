// Browser-side: a server's saved messages for its chat boxes, read once and kept for half a
// minute, so the Players tab's dialogs open with the list in hand. The owners' editor forgets
// them when it saves.
import { api } from './api';
import type { SavedMessage } from './saved-messages';

const FRESH_MS = 30_000;
const cache = new Map<string, { at: number; list: Promise<SavedMessage[]> }>();

/** The organisation's saved messages, as offered on this server; a refusal (no Chat) rejects. */
export function savedMessagesOn(serverId: string): Promise<SavedMessage[]> {
	const hit = cache.get(serverId);
	if (hit && Date.now() - hit.at < FRESH_MS) return hit.list;
	const list = api<{ messages: SavedMessage[] }>(
		'GET',
		`/api/servers/${encodeURIComponent(serverId)}/saved-messages`
	).then((r) => r.messages);
	cache.set(serverId, { at: Date.now(), list });
	list.catch(() => {
		if (cache.get(serverId)?.list === list) cache.delete(serverId);
	});
	return list;
}

/** After the owners' editor saves: the next chat box to open reads them again. */
export function forgetSavedMessages(): void {
	cache.clear();
}
