<script lang="ts">
	// The leaderboard as both the panel tab and the public page show it: the controls (scope,
	// range, playtime floor), one page of ranked rows with sortable headers, and the pager. The
	// board itself comes from the caller, which reloads it whenever `onchange` hands back a query.
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { fmtCash } from '$lib/cash';
	import { fmtMinutes, fmtNum, fmtTime, fmtAgo } from '$lib/format';
	import {
		BOARD_RANGES,
		kdRatio,
		perHour,
		winRate,
		type BoardMetric,
		type BoardQuery,
		type BoardView
	} from '$lib/leaderboard';
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
		exportHref = ''
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
	// The search, the same way: the field holds what is typed and follows the query; a pause in
	// the typing applies it (as the Players tab's search does), so a name is one read, not ten.
	let search = $state('');
	$effect(() => {
		search = query.q;
	});
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function searchSoon() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			const v = search.trim();
			if (v !== query.q) set({ q: v });
		}, 300);
	}
	$effect(() => () => clearTimeout(searchTimer));
	let pages = $derived(
		board
			? Math.min(board.maxPage ?? Infinity, Math.max(1, Math.ceil(board.total / board.pageSize)))
			: 1
	);
	const ratio = (v: number | null, digits = 2) => (v === null ? '—' : v.toFixed(digits));
	const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
	const seen = (iso: string | null) => (iso ? (relative ? fmtAgo(iso) : fmtTime(iso)) : '—');
</script>

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
	<div class="join">
		{#each BOARD_RANGES as r (r.key)}
			<button
				class="btn btn-sm {query.range === r.key ? 'btn-primary' : ''}"
				onclick={() => set({ range: r.key })}>{r.label}</button
			>
		{/each}
	</div>
	<label class="join items-center" title="Players with less playtime in the range are left out">
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
	<input
		class="h-[30px] input w-full py-0 sm:w-56"
		type="search"
		placeholder={showIds ? 'Name, alias or SteamID…' : 'Name…'}
		aria-label="Search the leaderboard"
		title="Narrows the rows; each player keeps their place on the whole board"
		bind:value={search}
		oninput={searchSoon}
	/>
	<span class="ml-auto text-[12.5px] text-mist-600">
		{#if board}{fmtNum(board.total)} player{board.total === 1 ? '' : 's'}{#if query.q}
				matching{/if}{#if loading}
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
				<SortHeader {sort} key="playtime" num>Playtime</SortHeader>
				<SortHeader
					{sort}
					key="seeded"
					num
					title="Time on with the server low, as a Seeding reward rule counts it">Seeded</SortHeader
				>
				<SortHeader {sort} key="kills" num>K</SortHeader>
				<SortHeader {sort} key="deaths" num>D</SortHeader>
				<SortHeader {sort} key="kd" num>K/D</SortHeader>
				<SortHeader {sort} key="perHour" num title="Kills per hour of playtime">K/h</SortHeader>
				<th class="num" title="Headshots">HS</th>
				<th class="num" title="Team kills">TK</th>
				<SortHeader {sort} key="matches" num>Matches</SortHeader>
				<SortHeader {sort} key="wins" num title="Wins, losses, draws">W-L-D</SortHeader>
				<SortHeader {sort} key="winRate" num>Win %</SortHeader>
				<SortHeader {sort} key="cash" num>Cash</SortHeader>
				<th>Last seen</th>
			</tr>
		</thead>
		<tbody>
			{#each board?.rows ?? [] as r (r.steamId)}
				<tr>
					<td class="num text-mist-400">{r.rank}</td>
					<td>
						<a href={hrefFor(r.steamId)} class="hover:text-accent hover:underline">{r.name}</a>
						{#if showIds}<span class="font-mono text-[12px] text-mist-600">{r.steamId}</span>{/if}
					</td>
					<td class="num">{fmtMinutes(r.minutes)}</td>
					<td class="num">{r.seedMinutes ? fmtMinutes(r.seedMinutes) : '—'}</td>
					<td class="num">{fmtNum(r.kills)}</td>
					<td class="num">{fmtNum(r.deaths)}</td>
					<td class="num">{ratio(kdRatio(r.kills, r.deaths))}</td>
					<td class="num">{ratio(perHour(r.kills, r.minutes, r.seedMinutes), 1)}</td>
					<td class="num">{r.headshots}</td>
					<td class="num {r.teamKills >= 3 ? 'text-warn' : ''}">{r.teamKills}</td>
					<td class="num">{r.matches}</td>
					<td class="num whitespace-nowrap">{r.wins}-{r.losses}-{r.draws}</td>
					<td class="num">{pct(winRate(r.wins, r.losses, r.draws))}</td>
					<td class="num">{fmtCash(r.cash)}</td>
					<td class="whitespace-nowrap text-mist-400">{seen(r.lastSeen)}</td>
				</tr>
			{:else}
				<tr>
					<td colspan="15" class="py-6 text-center text-mist-600">
						{#if !board || loading}Loading…{:else if board.total === 0 && query.q}Nobody on this
							board matches “{query.q}”.{:else if board.total === 0 && query.minMinutes > 0}Nobody
							has {fmtMinutes(query.minMinutes)} of playtime in this range yet.{:else}No players in
							this range yet.{/if}
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
{#if board && !board.hasFeed}
	<p class="note">
		{query.scope === 'org' ? 'None of these servers has' : 'This server has no'} kill feed, so headshots,
		team kills, suicides and streaks are not recorded; kills, deaths and results come from the game's
		own scoreboard, match by match.
	</p>
{/if}
