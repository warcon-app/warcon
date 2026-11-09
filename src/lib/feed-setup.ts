// How a server is told to post its kill feed here. Builds up to CL-509546 read `[WDServerFeed]`
// Url and Token, which the panel writes through the config document. CL-516586 (Season 2) reads
// a list of endpoints from the RCON block instead, keys RCON cannot write: the host pastes the
// lines into ServerSettings.ini and restarts the server.
import type { ConfigSection } from './types';

/** The section the lines go under. */
export const EVENT_FEED_SECTION = '/Script/WDRCON.WDRCONSettings';

/** Where the game posts its feed here (src/routes/api/ingest/events). */
export const INGEST_PATH = '/api/ingest/events';

/**
 * The Url of an EventFeedEndpoints entry. Season 2 posts to it exactly as written, so it names the
 * route; `[WDServerFeed]` Url was a base the game added the path to, so it holds the origin alone.
 */
export const eventFeedUrl = (origin: string): string => origin.replace(/\/+$/, '') + INGEST_PATH;

/** Whether the server reads its feed from EventFeedEndpoints, by the schema it publishes. */
export const usesEventFeed = (sections: ConfigSection[] | null | undefined): boolean =>
	!!sections?.some((s) => s.allowedKeys?.some((k) => k.toLowerCase() === 'eventfeedendpoints'));

/**
 * The lines for the RCON block: the feed switched on, this panel (at `origin`) as one of its
 * endpoints, and the name the game sends with each batch (Warcon goes by the token, but the game
 * may want one).
 */
export const eventFeedLines = (origin: string, token: string, name: string): string =>
	[
		'bEventFeedEnabled=True',
		`+EventFeedEndpoints=(Url="${eventFeedUrl(origin)}",Token="${token}")`,
		`EventFeedServerName="${name.replace(/["\r\n]/g, '').trim()}"`
	].join('\n');
