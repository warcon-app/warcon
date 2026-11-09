// Clan tags, as the Team balance rule and the Players tab's Teams view both read them.

/**
 * A player's clan tag: a short tag in brackets at the front of the name ("[ABC] Name", "{ABC}Name"),
 * in one case, or null.
 */
export function clanTag(name: string): string | null {
	const m = /^\s*(?:\[([^\]]{1,12})\]|\{([^}]{1,12})\}|\(([^)]{1,12})\)|<([^>]{1,12})>)/u.exec(
		name
	);
	const tag = (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? '').normalize('NFKC').trim().toLowerCase();
	return tag || null;
}
