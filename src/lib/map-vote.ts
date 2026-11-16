// The Map vote rule's settings as the editor and the server share them: what a new rule starts
// from, and the bounds each number is held to. Pure and client-safe; the rule itself is
// server/map-vote.ts.

/** What a new Map vote rule starts from. */
export const MAP_VOTE_DEFAULTS = {
	/** the leading side's score that opens the vote: KOTH plays to 100, a point a score tick */
	startAt: 90,
	/** how long the vote stays open */
	seconds: 120,
	/** how many maps a vote offers */
	options: 3,
	/** players on for a vote to open */
	minPlayers: 10,
	/** votes for a result: fewer, and the rotation goes on as it was */
	minVotes: 1,
	openMessage: 'Next map vote ({seconds} s). Type in chat: {options}',
	tallyMessage: 'Votes so far: {tally}',
	resultMessage: '{winner} won the vote ({votes} of {total}) and plays next.',
	noneMessage: 'No votes for the next map: the rotation goes on as planned.'
} as const;

/** The least and most each number may be. */
export const MAP_VOTE_LIMITS = {
	startAt: [10, 99],
	seconds: [30, 300],
	options: [2, 5],
	minPlayers: [1, 200],
	minVotes: [1, 100]
} as const satisfies Record<string, readonly [number, number]>;
