// A server's stats purge: what the game recorded about play on it (its kills, matches, match
// rows and the feed's match events) deleted for good by an org owner, audited with the counts. Sessions stay: they are
// presence (who was on, playtime, seed time, first visits), not stats. The worker needs no nudge:
// it re-reads the open match row on every status look and opens a new one when none is, so a
// match in progress is recorded from the purge onward as a fresh row, and the feed's next batch
// carries that row too.
import { sql } from 'drizzle-orm';
import type { Env } from './env';
import type { ServerRow, SessionUser } from './access';
import { writeAudit } from './audit';
import { forgetBoards } from './leaderboards';
import { lockTotals } from './totals';

export interface PurgeCounts {
	kills: number;
	matches: number;
	matchPlayers: number;
	matchEvents: number;
}

export async function purgeServerStats(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow
): Promise<PurgeCounts> {
	const counts = await env.db.transaction(async (tx) => {
		// The deletes recount the server's totals (migration 0038): the totals lock first, as the
		// worker takes it before it closes a session or ends a match (totals.ts).
		await lockTotals(tx, server.id);
		const del = async (table: 'kills' | 'match_players' | 'matches' | 'match_events') => {
			const [row] = await tx.execute<{ n: string }>(sql`
				WITH d AS (DELETE FROM ${sql.raw(table)} WHERE server_id = ${server.id} RETURNING 1)
				SELECT COUNT(*) AS n FROM d`);
			return Number(row?.n ?? 0);
		};
		const kills = await del('kills');
		const matchPlayers = await del('match_players');
		const matches = await del('matches');
		const matchEvents = await del('match_events');
		return { kills, matches, matchPlayers, matchEvents };
	});
	// The boards this web process keeps for a minute would show the purged numbers until then.
	forgetBoards(server.id);
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'server.stats.purge',
		outcome: 'ok',
		target: server.name,
		detail: counts,
		message: `${counts.kills} kills, ${counts.matches} matches, ${counts.matchPlayers} match rows and ${counts.matchEvents} match events deleted.`
	});
	return counts;
}
