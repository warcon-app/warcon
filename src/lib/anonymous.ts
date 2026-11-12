// Anonymous mode. A player can hide their name in the game's options; the other players then see a
// name the game made up for them, on the scoreboard, in the kill feed and in the chat. From Season 3
// (CL-533689) the game tells RCON both: every row of GET /v1/players, and every chat line, carries
// `hiddenName` (each player has one) and `anonymous` (whether it is the one in use).
//
// Seen on a live server on 2026-11-12, 100 players: every one with a hidden name, a single word of
// 3 to 9 letters, 96 different ones among them (two players can share one); one player anonymous,
// their `name` still their own, their SteamID there as for anyone. On five other servers the event
// feed named each of the 422 players it mentioned exactly as the list did, which points to the feed
// giving a player's own name too (nobody anonymous was picked out among them, so it is not proof).
// So what other players will read names a player from the list, by SteamID, wherever the
// worker has them there (or in a session still open), and from the feed only when it does not.
//
// The panel's rule: staff see both names. Anyone else (the other players, through a rule's
// message; the public, on a server's status page and a match's page; a Discord status board)
// gets the name the game itself shows them, and no way from it to who the player is. A session
// and a player's line of a match keep the hidden name they were played under, so the rule holds
// for what is read later too; a session also keeps whether its last look still saw the player in
// the mode, which is what names them once they are off the list. A public career keeps to the
// rule where it would otherwise point at the player (the matches it lists, its most killed and
// nemeses). The public boards and a career's totals are outside it so far: they count hidden play
// under the player's own name, and where a server's leaderboards are public that gives its hidden
// players away (the README says how).

/** What a player in anonymous mode goes by when the game sent no hidden name with them. */
export const ANONYMOUS = 'Anonymous';

const MAX_NAME = 64;

/**
 * The hidden name a player's row from the game holds while they are in anonymous mode, as one
 * short line of text; undefined for everyone else. A row carries it only then: every player has a
 * hidden name, and one nobody is shown is nothing to keep.
 */
export function hiddenNameOf(
	raw: { hiddenName?: unknown; anonymous?: unknown } | null | undefined
): string | undefined {
	if (!raw || raw.anonymous !== true) return undefined;
	const name =
		typeof raw.hiddenName === 'string'
			? raw.hiddenName
					.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
					.trim()
					.slice(0, MAX_NAME)
			: '';
	return name || ANONYMOUS;
}

/** The name the other players see: the hidden one in anonymous mode, else the player's own. */
export const seenAs = (p: { name: string; hiddenName?: string | null }): string =>
	p.hiddenName || p.name;

/** Whether the player is in anonymous mode, as far as their row says. */
export const isAnonymous = (p: { hiddenName?: string | null }): boolean => !!p.hiddenName;
