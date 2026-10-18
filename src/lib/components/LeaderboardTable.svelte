<script lang="ts">
	// The leaderboard as both the panel tab and the public page show it: what it covers (a season,
	// or a range) with the picker, a finished season's winners, the controls (scope, playtime
	// floor), one page of ranked rows with sortable headers (on a public page, without the columns
	// the organisation leaves out), and the pager. The board itself comes from the caller, which
	// reloads it whenever `onchange` hands back a query.
	import Badge from '$lib/components/Badge.svelte';
	import SeasonPicker from '$lib/components/SeasonPicker.svelte';
	import SeasonWinners from '$lib/components/SeasonWinners.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { fmtCash } from '$lib/cash';
	import { fmtMinutes, fmtNum, fmtTime, fmtAgo } from '$lib/format';
	import {
		BOARD_COLUMNS,
		BOARD_RANGES,
		kdRatio,
		perHour,
		perMinute,
		winRate,
		type BoardColumn,
		type BoardMetric,
		type BoardQuery,
		type BoardView
	} from '$lib/leaderboard';
	import { nextSeason, seasonDay, seasonSpan, WINNER_MIN_MATCHES } from '$lib/seasons';
	import type { SortLike } from '$lib/table.svelte';

	let {
		board,
		query,
		loading = false,
		onchange,
		hrefFor,
		orgName = '',
		/** offer the organisation scope (the panel always does; a public page only with more than one public server) */
		orgScope = true,
		/** show SteamIDs under the names (the panel does, a public page does not) */
		showIds = false,
		/** relative "last seen" times (public pages) rather than clock times */
		relative = false,
		/** where Export CSV downloads the board as it is set (the panel only) */
		exportHref = '',
		/** the columns the organisation's public boards leave out (public pages only) */
		hidden = []
	}: {
		board: BoardView | null;
		query: BoardQuery;
		loading?: boolean;
		onchange: (q: BoardQuery) => void;
		hrefFor: (steamId: string) => string;
		orgName?: string;
		orgScope?: boolean;
		showIds?: boolean;
		relative?: boolean;
		exportHref?: string;
		hidden?: readonly BoardColumn[];
	} = $props();

	const set = (patch: Partial<BoardQuery>) =>
		onchange({ ...query, ...patch, page: patch.page ?? 1 });
	// Every metric ranks biggest first on the first click, then the other way round; there is
	// no "off" since a board is always in some order.
	const sort: SortLike<BoardMetric> = {
		get key() {
			return query.sort;
		},
		get dir() {
			return query.dir;
		},
		toggle(key: BoardMetric) {
			if (query.sort !== key) set({ sort: key, dir: 'desc' });
			else set({ dir: query.dir === 'desc' ? 'asc' : 'desc' });
		}
	};
	// The field holds what is being typed; it follows the query whenever that changes.
	let floor = $state('');
	$effect(() => {
		floor = String(query.minMinutes);
	});
	function applyFloor() {
		const n = Math.max(0, Math.round(Number(floor) || 0));
		if (n !== query.minMinutes) set({ minMinutes: n });
	}
	let pages = $derived(
		board
			? Math.min(board.maxPage ?? Infinity, Math.max(1, Math.ceil(board.total / board.pageSize)))
			: 1
	);
	const ratio = (v: number | null, digits = 2) => (v === null ? '—' : v.toFixed(digits));
	const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
	const seen = (iso: string | null) => (iso ? (relative ? fmtAgo(iso) : fmtTime(iso)) : '—');

	let when = $derived(board?.when ?? null);
	let season = $derived(when?.season ?? null);
	/** a finished season's board no longer changes: nobody's last sighting means anything on it */
	let final = $derived(!!when?.finished);
	let next = $derived(season && board ? nextSeason(board.seasons, season) : null);
	let rangeLabel = $derived(BOARD_RANGES.find((r) => r.key === when?.range)?.label ?? 'All time');
	let what = $derived(season ? 'season' : 'range');
	/** The columns after rank and player: those not left out here, and no Last seen once final. */
	let shown = $derived(
		BOARD_COLUMNS.filter((c) => !hidden.includes(c.key) && !(final && c.key === 'lastSeen')).map(
			(c) => c.key
		)
	);
	const show = (c: BoardColumn) => shown.includes(c);
	/** what the heading says under the name */
	let span = $derived.by(() => {
		if (!when) return '';
		if (season) {
			if (final) return `${seasonSpan(season)} · final standings`;
			const since = `Since ${seasonDay(season.startsAt)}`;
			return season.endsAt
				? `${since} · ends ${seasonDay(season.endsAt)}`
				: `${since} · runs until the next season starts`;
		}
		return when.range === 'all' ? 'Every match on record' : `The last ${rangeLabel}, to now`;
	});
</script>

{#if board && when}
	<div class="mb-[18px] flex flex-wrap items-end gap-x-4 gap-y-3">
		<div class="min-w-0">
			<div class="flex items-center gap-2">
				<Badge
					>{season
						? season.kind === 'official'
							? 'Official season'
							: `${orgName || 'Our'} season`
						: 'Range'}</Badge
				>
				{#if season}<Badge tone={final ? '' : 'ok'}>{final ? 'Finished' : 'Live'}</Badge>{/if}
			</div>
			<h2 class="mt-2 font-display text-[28px] leading-none sm:text-[36px]">
				{season ? season.name : rangeLabel}
			</h2>
			<p class="mt-1.5 text-[13px] text-mist-400">{span}</p>
		</div>
		<div class="sm:ml-auto">
			<SeasonPicker
				{when}
				seasons={board.seasons}
				{orgName}
				disabled={loading}
				onpick={(range) => set({ range })}
			/>
		</div>
	</div>
	{#if board.winners}<SeasonWinners winners={board.winners} {hrefFor} />{/if}
{/if}

<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
	{#if orgScope}
		<div class="join">
			<button
				class="btn btn-sm {query.scope === 'server' ? 'btn-primary' : ''}"
				onclick={() => set({ scope: 'server' })}>This server</button
			>
			<button
				class="btn btn-sm {query.scope === 'org' ? 'btn-primary' : ''}"
				onclick={() => set({ scope: 'org' })}
				title={orgName ? `Every server of ${orgName}` : 'Every server of the organisation'}
				>Organisation</button
			>
		</div>
	{/if}
	<label class="join items-center" title="Players with less playtime in the {what} are left out">
		<span class="pointer-events-none btn btn-sm">At least</span>
		<input
			class="h-[30px] input w-20 py-0 text-right"
			type="number"
			min="0"
			step="10"
			aria-label="Playtime floor in minutes"
			bind:value={floor}
			onchange={applyFloor}
			onkeydown={(e) => e.key === 'Enter' && applyFloor()}
		/>
		<span class="pointer-events-none btn btn-sm">min played</span>
	</label>
	<span class="ml-auto text-[12.5px] text-mist-600">
		{#if board}{fmtNum(board.total)} player{board.total === 1 ? '' : 's'}{#if loading}
				· loading…{/if}{:else}Loading…{/if}
	</span>
	{#if exportHref}
		<a class="btn btn-sm" href={exportHref} target="_blank" rel="noopener">Export CSV</a>
	{/if}
</div>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th class="num">#</th>
				<th>Player</th>
				{#if show('playtime')}<SortHeader {sort} key="playtime" num>Playtime</SortHeader>{/if}
				{#if show('seeded')}
					<SortHeader
						{sort}
						key="seeded"
						num
						title="Time on with the server low, as a Seeding reward rule counts it"
						>Seeded</SortHeader
					>
				{/if}
				<SortHeader {sort} key="kills" num>K</SortHeader>
				{#if show('deaths')}<SortHeader {sort} key="deaths" num>D</SortHeader>{/if}
				{#if show('kd')}<SortHeader {sort} key="kd" num>K/D</SortHeader>{/if}
				{#if show('perHour')}
					<SortHeader {sort} key="perHour" num title="Kills per hour of playtime">K/h</SortHeader>
				{/if}
				{#if show('headshots')}<th class="num" title="Headshots">HS</th>{/if}
				{#if show('teamKills')}<th class="num" title="Team kills">TK</th>{/if}
				{#if show('matches')}<SortHeader {sort} key="matches" num>Matches</SortHeader>{/if}
				{#if show('results')}
					<SortHeader {sort} key="wins" num title="Wins, losses, draws">W-L-D</SortHeader>
				{/if}
				{#if show('winRate')}<SortHeader {sort} key="winRate" num>Win %</SortHeader>{/if}
				{#if show('cash')}<SortHeader {sort} key="cash" num>Cash</SortHeader>{/if}
				{#if show('cashPerMin')}
					<SortHeader
						{sort}
						key="cashPerMin"
						num
						title="Cash per minute of the sessions it was made in, seed time left out"
						>$/min</SortHeader
					>
				{/if}
				{#if show('lastSeen')}<th>Last seen</th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each board?.rows ?? [] as r (r.steamId)}
				<tr>
					<td class="num text-mist-400">{r.rank}</td>
					<td>
						<a
							href={hrefFor(r.steamId)}
							data-sveltekit-preload-data="tap"
							class="hover:text-accent hover:underline">{r.name}</a
						>
						{#if showIds}<span class="font-mono text-[12px] text-mist-600">{r.steamId}</span>{/if}
					</td>
					{#if show('playtime')}<td class="num">{fmtMinutes(r.minutes)}</td>{/if}
					{#if show('seeded')}
						<td class="num">{r.seedMinutes ? fmtMinutes(r.seedMinutes) : '—'}</td>
					{/if}
					<td class="num">{fmtNum(r.kills)}</td>
					{#if show('deaths')}<td class="num">{fmtNum(r.deaths)}</td>{/if}
					{#if show('kd')}<td class="num">{ratio(kdRatio(r.kills, r.deaths))}</td>{/if}
					{#if show('perHour')}
						<td class="num"
							>{ratio(perHour(r.kills, r.minutes, r.seedMinutes, r.idleMinutes), 1)}</td
						>
					{/if}
					{#if show('headshots')}<td class="num">{r.headshots}</td>{/if}
					{#if show('teamKills')}
						<td class="num {r.teamKills >= 3 ? 'text-warn' : ''}">{r.teamKills}</td>
					{/if}
					{#if show('matches')}<td class="num">{r.matches}</td>{/if}
					{#if show('results')}
						<td class="num whitespace-nowrap">{r.wins}-{r.losses}-{r.draws}</td>
					{/if}
					{#if show('winRate')}<td class="num">{pct(winRate(r.wins, r.losses, r.draws))}</td>{/if}
					{#if show('cash')}<td class="num">{fmtCash(r.cash)}</td>{/if}
					{#if show('cashPerMin')}
						<td class="num"
							>{fmtCash(perMinute(r.cash, r.cashMinutes, r.seedMinutes, r.idleMinutes))}</td
						>
					{/if}
					{#if show('lastSeen')}
						<!-- A clock time may wrap after its date: the panel's rows are two lines (name, SteamID) anyway. -->
						<td class="text-mist-400 {relative ? 'whitespace-nowrap' : ''}">{seen(r.lastSeen)}</td>
					{/if}
				</tr>
			{:else}
				<tr>
					<td colspan={2 + shown.length} class="py-6 text-center text-mist-600">
						{#if !board || loading}Loading…{:else if board.total === 0 && query.minMinutes > 0}Nobody
							has {fmtMinutes(query.minMinutes)} of playtime in this {what}{final
								? ''
								: ' yet'}.{:else}No players in this {what}{final ? '' : ' yet'}.{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
{#if board && pages > 1}
	<div class="mt-3 flex items-center gap-2 text-[12.5px] text-mist-400">
		<button
			class="btn btn-sm"
			disabled={query.page <= 1 || loading}
			onclick={() => onchange({ ...query, page: query.page - 1 })}>← Newer</button
		>
		<span>Page {query.page} of {pages}</span>
		<button
			class="btn btn-sm"
			disabled={query.page >= pages || loading}
			onclick={() => onchange({ ...query, page: query.page + 1 })}>Next →</button
		>
	</div>
{/if}
{#if board && season}
	<p class="note">
		{#if final}{season.name} ended when {next?.name ?? 'the next season'} started; its board counts the
			matches that ended before then and no longer changes, so Last seen is left off. A player needs at
			least {WINNER_MIN_MATCHES} matches in the season to win on K/D.{:else}{season.name}
			counts the matches that ended since it started; all time and the other ranges are in the picker.{/if}
	</p>
{/if}
{#if board && !board.hasFeed && (show('headshots') || show('teamKills'))}
	<p class="note">
		{query.scope === 'org' ? 'None of these servers has' : 'This server has no'} kill feed, so headshots,
		team kills, suicides and streaks are not recorded; kills, deaths and results come from the game's
		own scoreboard, match by match.
	</p>
{/if}
