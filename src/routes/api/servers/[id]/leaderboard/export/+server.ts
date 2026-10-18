// The leaderboard as a CSV file: the board as it is set (scope, range, sort, playtime floor), from
// the top, every page of it up to EXPORT_ROWS players. The same check as the board (View); the
// organisation scope covers the servers the caller can open, as the board's does.
// ?scope=server|org&range=current|s:<season>|7d|30d|90d|all&sort=<metric>&dir=asc|desc&minMinutes=60
import { getEnv } from '$lib/server/env';
import { param, route } from '$lib/server/http';
import { accessibleServers, getOrg, requireServerCap } from '$lib/server/access';
import { assertRate } from '$lib/server/ratelimit';
import { exportBoard } from '$lib/server/leaderboards';
import { boardWindow } from '$lib/server/seasons';
import { csvCell, fileSlug } from '$lib/server/csv';
import {
	kdRatio,
	parseBoardQuery,
	perHour,
	perMinute,
	winRate,
	type BoardRow
} from '$lib/leaderboard';

/** Rounded to `digits` places; empty where the ratio has nothing to divide by. */
const round = (v: number | null, digits: number): number | null =>
	v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;
const percent = (v: number | null) => (v === null ? null : round(v * 100, 1));

const COLUMNS: [string, (r: BoardRow) => unknown][] = [
	['rank', (r) => r.rank],
	['steam_id', (r) => r.steamId],
	['name', (r) => r.name],
	['playtime_min', (r) => r.minutes],
	['seeded_min', (r) => r.seedMinutes],
	['kills', (r) => r.kills],
	['deaths', (r) => r.deaths],
	['kd', (r) => round(kdRatio(r.kills, r.deaths), 2)],
	['kills_per_hour', (r) => round(perHour(r.kills, r.minutes, r.seedMinutes, r.idleMinutes), 1)],
	['headshots', (r) => r.headshots],
	['team_kills', (r) => r.teamKills],
	['suicides', (r) => r.suicides],
	['vehicle_kills', (r) => r.vehicleKills],
	['kill_streak', (r) => r.killStreak],
	['death_streak', (r) => r.deathStreak],
	['matches', (r) => r.matches],
	['wins', (r) => r.wins],
	['losses', (r) => r.losses],
	['draws', (r) => r.draws],
	['win_pct', (r) => percent(winRate(r.wins, r.losses, r.draws))],
	['cash', (r) => r.cash],
	['cash_per_min', (r) => round(perMinute(r.cash, r.cashMinutes, r.seedMinutes, r.idleMinutes), 1)],
	['last_seen', (r) => r.lastSeen]
];

export const GET = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'server.view'
	);
	// Each download is one aggregate over the whole range, as a page view is.
	assertRate(`board-export:${user.id}`, 10, 60_000);
	const q = parseBoardQuery(event.url.searchParams);
	const org = q.scope === 'org' ? await getOrg(env, server.orgId) : null;
	const ids = org
		? (await accessibleServers(env, user, server.orgId)).map((s) => s.id)
		: [server.id];
	const win = await boardWindow(env, server.orgId, q.range);
	const rows = await exportBoard(env, ids, q, win);
	const lines = [COLUMNS.map(([name]) => name).join(',')];
	for (const r of rows) lines.push(COLUMNS.map(([, value]) => csvCell(value(r))).join(','));
	const day = new Date().toISOString().slice(0, 10);
	const span = win.season ? fileSlug(win.season.name) || 'season' : win.range;
	const file = `${fileSlug(org?.name ?? server.name)}-leaderboard-${span}-${day}.csv`;
	return new Response(lines.join('\r\n'), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${file}"`,
			'cache-control': 'private, no-store'
		}
	});
});
