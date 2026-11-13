// The Discord roles a webhook pings when it carries a Staff call. An organisation's owner gives
// each role's ID: Discord's own number for it (Server settings → Roles → ⋯ → Copy Role ID, with
// Developer Mode on), or the mention as Discord writes it, <@&id>. Only the numbers are kept, and
// the mentions sent are built from them and nothing else, so no name, word or @everyone can ride
// in on one. Pure and client-safe.

/** A webhook pings its roles for Staff calls at most once in this many minutes. */
export const STAFF_PING_MINUTES = 5;
/** The most roles one webhook pings: staff, their seniors, an on-call role; not a roll call. */
export const MAX_STAFF_ROLES = 5;

// A Discord ID is a number of up to 63 bits written out: 17 digits for the oldest still in use, 19
// at most, and none past the largest such number. Discord refuses a whole message for one that is
// out of that range, so a slip of the hand is refused here, where its owner sees it.
const DIGITS = /^[1-9]\d{16,18}$/;
const MAX = 9223372036854775807n;
const isId = (id: unknown): id is string =>
	typeof id === 'string' && DIGITS.test(id) && BigInt(id) <= MAX;
const MENTION = /^<@&(\d+)>$/;

/**
 * A role's ID from what an owner pasted: the number, or the mention <@&number>; null when it is
 * neither. Never a JavaScript number: one of this size does not survive being one.
 */
export function parseRoleId(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const text = raw.trim();
	const id = MENTION.exec(text)?.[1] ?? text;
	return isId(id) ? id : null;
}

/**
 * Several roles from what an owner pasted or a client sent: IDs or mentions in one text, with
 * spaces, commas or new lines between (or nothing, between two mentions), or a list of them. Each
 * once, in the order given; an empty text or list is no roles. null when any part is not a role's
 * ID: one wrong part refuses the lot, rather than pinging some of what was meant. How many a
 * webhook may hold (MAX_STAFF_ROLES) is for whoever keeps them to say.
 */
export function parseRoleIds(raw: unknown): string[] | null {
	const parts =
		typeof raw === 'string'
			? raw
					.replace(/></g, '> <')
					.split(/[\s,]+/)
					.filter(Boolean)
			: Array.isArray(raw)
				? (raw as unknown[])
				: null;
	if (!parts) return null;
	const ids = parts.map(parseRoleId);
	return ids.every((id) => id !== null) ? [...new Set(ids as string[])] : null;
}

/**
 * The roles a stored or handed-on value holds, for whoever is about to ping them: those that are
 * role IDs, each once, MAX_STAFF_ROLES at most. Anything else in it is left out, never pinged.
 */
export function rolesToPing(raw: unknown): string[] {
	const list = Array.isArray(raw) ? (raw as unknown[]) : [];
	return [...new Set(list.filter(isId))].slice(0, MAX_STAFF_ROLES);
}

/** The mention of a role as a Discord message holds it; '' when the ID is not one. */
export const roleMention = (id: string): string => (isId(id) ? `<@&${id}>` : '');
