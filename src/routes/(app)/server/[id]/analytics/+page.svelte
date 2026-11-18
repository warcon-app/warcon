<script lang="ts">
	import { api, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { fmtNum, fmtTime, mapLabel, expSetLabel } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import PopulationChart from '$lib/components/PopulationChart.svelte';
	import CashChart from '$lib/components/CashChart.svelte';
	import PeriodChart, { periodName, type PeriodSeries } from '$lib/components/PeriodChart.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { TableSort } from '$lib/table.svelte';
	import { factionColor } from '$lib/format';
	import { causeLabel } from '$lib/causes';
	import type { Analytics, PeriodPoint, Periods, Range } from '$lib/server/analytics';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let range = $state<Range>('24h');
	let a = $state<Analytics | null>(null);
	let loading = $state(false);
	let view = $state<'chart' | 'table'>('chart');
	let cashView = $state<'chart' | 'table'>('chart');
	/** what the first chart shows: players online, or players or session lengths per period */
	let shown = $state<'online' | 'players' | 'sessions'>('online');
	let periods = $state<Periods | null>(null);

	const playerSort = new TableSort<Analytics['players'][number]>({
		player: { by: (p) => p.name },
		minutes: { by: (p) => p.minutes, dir: 'desc' },
		sessions: { by: (p) => p.sessions, dir: 'desc' },
		kills: { by: (p) => p.kills, dir: 'desc' },
		deaths: { by: (p) => p.deaths, dir: 'desc' },
		lastSeen: { by: (p) => p.lastSeen, dir: 'desc' }
	});
	let players = $derived(playerSort.sorted(a?.players ?? []));
	const matchSort = new TableSort<Analytics['matches'][number]>({
		started: { by: (m) => m.startedAt, dir: 'desc' },
		map: { by: (m) => (m.map ? mapLabel(data.catalog, m.map) : null) },
		mode: {
			by: (m) => expSetLabel(data.catalog, m.experiences ? m.experiences.split('+') : [])
		},
		length: {
			by: (m) => Date.parse(m.endedAt ?? new Date().toISOString()) - Date.parse(m.startedAt),
			dir: 'desc'
		},
		peak: { by: (m) => m.peakPlayers, dir: 'desc' },
		result: { by: (m) => m.winner }
	});
	let matchRows = $derived(matchSort.sorted(a?.matches ?? []));
	const combatSort = new TableSort<NonNullable<Analytics['combat']>['players'][number]>(
		{
			player: { by: (p) => p.name },
			kills: { by: (p) => p.kills, dir: 'desc' },
			deaths: { by: (p) => p.deaths, dir: 'desc' },
			headshots: { by: (p) => p.headshots, dir: 'desc' },
			teamKills: { by: (p) => p.teamKills, dir: 'desc' },
			distance: { by: (p) => p.avgDistanceM, dir: 'desc' }
		},
		{ key: 'kills' }
	);
	let combatPlayers = $derived(combatSort.sorted(a?.combat?.players ?? []));
	let maxCauseKills = $derived(Math.max(1, ...(a?.combat?.causes.map((c) => c.kills) ?? [])));
	let maxBucketKills = $derived(Math.max(1, ...(a?.combat?.perBucket.map((b) => b.kills) ?? [])));
	const pct = (part: number, whole: number) =>
		whole ? `${Math.round((part / whole) * 100)}%` : '—';
	const kd = (k: number, d: number) => (d ? (k / d).toFixed(2) : k ? `${k}.00` : '—');

	async function load() {
		loading = true;
		try {
			a = await api<Analytics>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/analytics?range=${range}`
			);
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		range;
		return poll(load, 60000);
	});

	// The browser's time zone, so a day on the charts is the viewer's day.
	const tz = (() => {
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
		} catch {
			return '';
		}
	})();
	async function loadPeriods() {
		try {
			const got = await api<Periods>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/analytics/periods?range=${range}&tz=${encodeURIComponent(tz)}`
			);
			// A slow answer for a range left since does not replace the one asked for now.
			if (got.range === range) periods = got;
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	// Read only while a chart that shows it is open; both of them show the same read.
	let perPeriod = $derived(shown !== 'online');
	$effect(() => {
		range;
		if (perPeriod) return poll(loadPeriods, 60000);
	});
	let periodWord = $derived(range === '24h' || range === '48h' ? 'hour' : 'day');
	const SHOWN = [
		['online', 'Players online'],
		['players', 'Players per'],
		['sessions', 'Session length']
	] as const;
	/** a length of time for an axis: "45 min", "1.5 h" */
	const span = (s: number) =>
		s <= 0
			? '0'
			: s < 60
				? `${Math.round(s)} s`
				: s < 3600
					? `${Math.round(s / 60)} min`
					: `${+(s / 3600).toFixed(1)} h`;
	/** a length of time to read: "45 min", "1 h 36 min" */
	const spanLong = (s: number) => {
		if (s < 60) return `${Math.round(s)} s`;
		const m = Math.round(s / 60);
		return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
	};
	const PLAYER_SERIES: PeriodSeries<PeriodPoint>[] = [
		{ key: 'new', label: 'New', color: '#5b95d8', value: (p) => p.newPlayers },
		{
			key: 'returning',
			label: 'Returning',
			color: '#c98500',
			value: (p) => p.players - p.newPlayers
		}
	];
	const SESSION_SERIES: PeriodSeries<PeriodPoint>[] = [
		{ key: 'avg', label: 'Average', color: '#d4a843', value: (p) => p.avgSessionS }
	];
	// Spacings that keep the axis on round lengths: 30 min, 1 h, 1.5 h rather than 1.3 h.
	const DURATION_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
	let periodRows = $derived(periods ? [...periods.periods].reverse() : []);

	const RANGES: { key: Range; label: string }[] = [
		{ key: '24h', label: '24 hours' },
		{ key: '48h', label: '48 hours' },
		{ key: '3d', label: '3 days' },
		{ key: '7d', label: '7 days' },
		{ key: '30d', label: '30 days' }
	];
	const minutes = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
	const duration = (from: string, to: string | null) =>
		minutes(Math.round((Date.parse(to ?? new Date().toISOString()) - Date.parse(from)) / 60000));
	let maxMapMinutes = $derived(Math.max(1, ...(a?.maps.map((m) => m.minutes) ?? [])));
	let maxTeamWins = $derived(Math.max(1, ...(a?.wins.teams.map((t) => t.wins) ?? [])));
	const plural = (n: number, one: string, many = `${one}s`) =>
		`${fmtNum(n)} ${n === 1 ? one : many}`;
	let winsFoot = $derived(
		a
			? [
					plural(a.wins.decided, 'match', 'matches'),
					...(a.wins.draws ? [plural(a.wins.draws, 'draw')] : []),
					...(a.wins.noResult ? [`${fmtNum(a.wins.noResult)} with no result`] : [])
				].join(' · ')
			: ''
	);
	let maxHourly = $derived(Math.max(1, ...(a?.hourly.map((h) => h.avg) ?? [])));
	// Derived rather than inlined in the each: state read only inside a callback of the each
	// expression compiles to non-reactive items, so the bars would freeze on their first values.
	let hourlyBars = $derived(
		Array.from({ length: 24 }, (_, h) => a?.hourly.find((x) => x.hour === h)?.avg ?? 0)
	);
</script>

<div class="mb-4 flex flex-wrap items-center gap-2">
	<div class="join">
		{#each RANGES as r (r.key)}
			<button
				class="btn btn-sm {range === r.key ? 'btn-primary' : ''}"
				onclick={() => (range = r.key)}>{r.label}</button
			>
		{/each}
	</div>
	<span class="ml-auto text-[12.5px] text-mist-600">
		{#if a}{fmtNum(a.summary.samples)} samples over {a.summary.coveredHours} h · heartbeat every {a.sampleSeconds}s
			plus every change{#if loading}
				· refreshing…{/if}{:else}Loading…{/if}
	</span>
</div>

{#if a}
	<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
		{#each [['Online now', String(a.summary.onlineNow)], ['Unique players', fmtNum(a.summary.uniquePlayers)], ['Peak', fmtNum(a.summary.peakPlayers)], ['Average', String(a.summary.avgPlayers)], ['Uptime', a.summary.uptimePct === null ? '—' : `${a.summary.uptimePct}%`], ['Matches', fmtNum(a.summary.matches)]] as [label, value] (label)}
			<div class="panel py-4">
				<div class="caps text-mist-400">{label}</div>
				<div class="mt-1 font-display text-3xl font-semibold tabular">{value}</div>
			</div>
		{/each}
	</div>

	<div class="mb-4 panel">
		<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
			<span class="join join-stack">
				{#each SHOWN as [key, name] (key)}
					<button
						class="btn btn-sm {shown === key ? 'btn-primary' : ''}"
						aria-pressed={shown === key}
						onclick={() => (shown = key)}
						>{name}{#if key === 'players'}&nbsp;{periodWord}{/if}</button
					>
				{/each}
			</span>
			{#if shown === 'online'}
				<span class="text-[12px] text-mist-600"
					>average per {a.bucketSeconds / 60} min bucket · red bands are outages</span
				>
			{:else if shown === 'sessions'}
				<span class="text-[12px] text-mist-600">average per {periods?.unit ?? periodWord}</span>
			{/if}
			{#if periods && perPeriod && periods.tz !== tz}
				<span class="text-[12px] text-mist-600">{periodWord}s in {periods.tz}</span>
			{/if}
			<span class="join ml-auto">
				<button
					class="btn btn-sm {view === 'chart' ? 'btn-primary' : ''}"
					onclick={() => (view = 'chart')}>Chart</button
				>
				<button
					class="btn btn-sm {view === 'table' ? 'btn-primary' : ''}"
					onclick={() => (view = 'table')}>Table</button
				>
			</span>
		</div>
		{#if shown !== 'online'}
			{#if !periods}
				<div class="py-10 text-center text-mist-600">Loading…</div>
			{:else}
				<div class="transition-opacity {periods.range !== range ? 'opacity-50' : ''}">
					{#if view === 'table'}
						<div class="max-h-[360px] table-wrap">
							<table>
								<thead>
									<tr>
										<th>{periods.unit === 'hour' ? 'Hour' : 'Day'}</th>
										<th class="num">Players</th>
										<th class="num">New</th>
										<th class="num">Returning</th>
										<th class="num">Sessions</th>
										<th class="num">Average</th>
										<th class="num">Median</th>
									</tr>
								</thead>
								<tbody>
									{#each periodRows as p, i (p.ts)}
										<tr>
											<td class="whitespace-nowrap"
												>{periodName(p.ts, periods.unit, periods.tz)}{#if i === 0}<span
														class="text-mist-600">&nbsp;· so far</span
													>{/if}</td
											>
											<td class="num">{fmtNum(p.players)}</td>
											<td class="num">{fmtNum(p.newPlayers)}</td>
											<td class="num">{fmtNum(p.players - p.newPlayers)}</td>
											<td class="num">{fmtNum(p.sessions)}</td>
											<td class="num">{p.avgSessionS === null ? '—' : spanLong(p.avgSessionS)}</td>
											<td class="num"
												>{p.medianSessionS === null ? '—' : spanLong(p.medianSessionS)}</td
											>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{:else if shown === 'players' && !periods.periods.some((p) => p.players)}
						<div class="py-10 text-center text-mist-600">No players in this range yet.</div>
					{:else if shown === 'players'}
						<PeriodChart
							points={periods.periods}
							series={PLAYER_SERIES}
							unit={periods.unit}
							tz={periods.tz}
							format={fmtNum}
							totalLabel="players"
							label="Players per {periods.unit}, new and returning"
						/>
					{:else if !periods.periods.some((p) => p.sessions)}
						<div class="py-10 text-center text-mist-600">No sessions ended in this range yet.</div>
					{:else}
						<PeriodChart
							points={periods.periods}
							series={SESSION_SERIES}
							unit={periods.unit}
							tz={periods.tz}
							format={span}
							tip={spanLong}
							steps={DURATION_STEPS}
							rows={(p) =>
								p.medianSessionS === null
									? []
									: [
											[spanLong(p.medianSessionS), 'median'],
											[fmtNum(p.sessions), p.sessions === 1 ? 'session' : 'sessions']
										]}
							label="Average session length per {periods.unit}"
						/>
					{/if}
				</div>
			{/if}
		{:else if view === 'chart'}
			<PopulationChart points={a.population} {range} />
		{:else}
			<div class="max-h-[360px] table-wrap">
				<table>
					<thead
						><tr
							><th>Bucket start</th><th class="num">Average</th><th class="num">Peak</th><th
								class="num">Capacity</th
							><th class="num">Reachable</th></tr
						></thead
					>
					<tbody>
						{#each a.population as p (p.ts)}
							<tr
								><td class="font-mono text-[12px]">{fmtTime(p.ts)}</td><td class="num"
									>{p.avg === null ? '—' : Math.round(p.avg)}</td
								><td class="num">{p.max ?? '—'}</td><td class="num">{p.cap ?? '—'}</td><td
									class="num">{p.ok}/{p.total}</td
								></tr
							>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<div class="mb-4 panel">
		<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
			<span class="label-sm mb-0">Cash in play</span>
			<span class="text-[12px] text-mist-600"
				>held by connected players · average per {a.bucketSeconds / 60} min bucket</span
			>
			<span class="join ml-auto">
				<button
					class="btn btn-sm {cashView === 'chart' ? 'btn-primary' : ''}"
					onclick={() => (cashView = 'chart')}>Chart</button
				>
				<button
					class="btn btn-sm {cashView === 'table' ? 'btn-primary' : ''}"
					onclick={() => (cashView = 'table')}>Table</button
				>
			</span>
		</div>
		<CashChart
			points={a.cash}
			view={cashView}
			{range}
			color={(name) => factionColor(name, null)}
			emptyText="No cash samples in this range yet. The poller records cash per faction with every sample."
		/>
	</div>

	<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
		<div class="panel">
			<span class="label-sm">Time per map</span>
			{#each a.maps as m (m.map)}
				<div class="mb-2.5">
					<div class="mb-1 flex justify-between text-[13px]">
						<span
							>{mapLabel(data.catalog, m.map)}
							<span class="text-mist-600">· {m.matches} match{m.matches === 1 ? '' : 'es'}</span
							></span
						><span class="font-mono text-mist-400 tabular">{minutes(m.minutes)}</span>
					</div>
					<div class="progress">
						<span class="progress-bar" style="width:{(m.minutes / maxMapMinutes) * 100}%"></span>
					</div>
				</div>
			{:else}
				<div class="text-mist-600">No data yet.</div>
			{/each}
		</div>
		<div class="panel">
			<span class="label-sm">Wins per team</span>
			{#each a.wins.teams as t (t.name)}
				{@const color = t.colorHex || factionColor(t.name)}
				<div class="mb-2.5">
					<div class="mb-1 flex justify-between text-[13px]">
						<span style="color:{color}"
							>{t.name} <span class="text-mist-600">· {pct(t.wins, a.wins.decided)}</span></span
						><span class="font-mono text-mist-400 tabular">{plural(t.wins, 'win')}</span>
					</div>
					<div class="progress">
						<span
							class="progress-bar"
							style="width:{(t.wins / maxTeamWins) * 100}%;background:{color}"
						></span>
					</div>
				</div>
			{:else}
				<div class="text-mist-600">No data yet.</div>
			{/each}
			{#if a.wins.decided || a.wins.noResult}
				<p class="mt-3 text-[12.5px] text-mist-600">{winsFoot}</p>
			{/if}
		</div>
		<div class="panel lg:col-span-2 xl:col-span-1">
			<span class="label-sm">Average players by hour (UTC)</span>
			{#if a.hourly.length}
				<div
					class="flex h-36 items-end gap-[3px]"
					role="img"
					aria-label="Average players by hour of day"
				>
					{#each hourlyBars as v, h (h)}
						<div class="group relative flex-1">
							<div
								class="w-full bg-accent/80 transition-[height]"
								style="height:{Math.max(2, (v / maxHourly) * 130)}px"
								title="{String(h).padStart(2, '0')}:00 · {v.toFixed(1)} avg"
							></div>
						</div>
					{/each}
				</div>
				<div class="mt-1 flex justify-between font-mono text-[10px] text-mist-600">
					<span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
				</div>
			{:else}
				<div class="text-mist-600">No data yet.</div>
			{/if}
		</div>
	</div>

	<div class="mb-4 panel">
		<span class="label-sm">Most active players</span>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<SortHeader sort={playerSort} key="player">Player</SortHeader>
						<SortHeader sort={playerSort} key="minutes" num>Playtime</SortHeader>
						<SortHeader sort={playerSort} key="sessions" num>Sessions</SortHeader>
						<SortHeader sort={playerSort} key="kills" num>K</SortHeader>
						<SortHeader sort={playerSort} key="deaths" num>D</SortHeader>
						<SortHeader sort={playerSort} key="lastSeen">Last seen</SortHeader>
					</tr>
				</thead>
				<tbody>
					{#each players as p (p.steamId)}
						<tr>
							<td
								>{p.name} <span class="font-mono text-[12px] text-mist-600">{p.steamId}</span>
								{#if p.online}<Badge tone="ok" class="ml-1">online</Badge>{/if}</td
							>
							<td class="num">{minutes(p.minutes)}</td><td class="num">{p.sessions}</td><td
								class="num">{fmtNum(p.kills)}</td
							><td class="num">{fmtNum(p.deaths)}</td>
							<td class="whitespace-nowrap text-mist-400">{fmtTime(p.lastSeen)}</td>
						</tr>
					{:else}
						<tr
							><td colspan="6" class="py-6 text-center text-mist-600"
								>No player sessions in this range.</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	{#if a.combat}
		<div class="mb-4 panel">
			<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
				<span class="label-sm mb-0">Combat</span>
				<span class="text-[12px] text-mist-600"
					>from the game's kill feed · kills per {a.bucketSeconds / 60} min bucket</span
				>
			</div>
			<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
				{#each [['Kills', fmtNum(a.combat.kills)], ['Headshots', `${fmtNum(a.combat.headshots)} · ${pct(a.combat.headshots, a.combat.kills)}`], ['Team kills', fmtNum(a.combat.teamKills)], ['Suicides', fmtNum(a.combat.suicides)], ['By vehicle', fmtNum(a.combat.vehicleKills)]] as [label, value] (label)}
					<div class="rounded-ctl border border-black bg-ink-950 px-3.5 py-3">
						<div class="caps text-mist-400">{label}</div>
						<div class="mt-1 font-display text-2xl font-semibold tabular">{value}</div>
					</div>
				{/each}
			</div>
			{#if a.combat.perBucket.length}
				<div class="flex h-28 items-end gap-[2px]" role="img" aria-label="Kills per bucket">
					{#each a.combat.perBucket as b (b.ts)}
						<div
							class="min-w-[2px] flex-1 bg-accent/80"
							style="height:{Math.max(2, (b.kills / maxBucketKills) * 100)}px"
							title="{fmtTime(b.ts)} · {b.kills} kill{b.kills === 1 ? '' : 's'}"
						></div>
					{/each}
				</div>
			{:else}
				<div class="text-mist-600">No kills in this range yet.</div>
			{/if}
		</div>

		<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
			<div class="panel">
				<span class="label-sm">Weapons and vehicles</span>
				{#each a.combat.causes as c (c.cause)}
					<div class="mb-2.5">
						<div class="mb-1 flex justify-between text-[13px]">
							<span
								>{causeLabel(c.cause)}
								<span class="text-mist-600">· {pct(c.headshots, c.kills)} headshots</span></span
							><span class="font-mono text-mist-400 tabular">{fmtNum(c.kills)}</span>
						</div>
						<div class="progress">
							<span class="progress-bar" style="width:{(c.kills / maxCauseKills) * 100}%"></span>
						</div>
					</div>
				{:else}
					<div class="text-mist-600">No data yet.</div>
				{/each}
			</div>
			<div class="panel">
				<span class="label-sm">Longest kills</span>
				<div class="table-wrap">
					<table>
						<thead
							><tr
								><th>When</th><th>Killer</th><th>Victim</th><th>Cause</th><th class="num"
									>Distance</th
								></tr
							></thead
						>
						<tbody>
							{#each a.combat.longest as l (l.ts + l.killer + l.victim)}
								<tr>
									<td class="whitespace-nowrap text-mist-400">{fmtTime(l.ts)}</td>
									<td>{l.killer}</td><td>{l.victim}</td>
									<td>{causeLabel(l.cause) || '—'}</td>
									<td class="num">{fmtNum(l.distanceM)} m</td>
								</tr>
							{:else}
								<tr><td colspan="5" class="py-6 text-center text-mist-600">No data yet.</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		</div>

		<div class="mb-4 panel">
			<span class="label-sm">Top killers</span>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<SortHeader sort={combatSort} key="player">Player</SortHeader>
							<SortHeader sort={combatSort} key="kills" num>K</SortHeader>
							<SortHeader sort={combatSort} key="deaths" num>D</SortHeader>
							<th class="num">K/D</th>
							<SortHeader sort={combatSort} key="headshots" num>Headshots</SortHeader>
							<SortHeader sort={combatSort} key="teamKills" num>Team kills</SortHeader>
							<SortHeader sort={combatSort} key="distance" num>Avg distance</SortHeader>
						</tr>
					</thead>
					<tbody>
						{#each combatPlayers as p (p.steamId)}
							<tr class={p.teamKills >= 3 ? 'text-warn' : ''}>
								<td
									><a
										href="/server/{encodeURIComponent(id)}/players/{p.steamId}"
										data-sveltekit-preload-data="tap"
										class="hover:text-accent hover:underline">{p.name}</a
									>
									<span class="font-mono text-[12px] text-mist-600">{p.steamId}</span></td
								>
								<td class="num">{fmtNum(p.kills)}</td><td class="num">{fmtNum(p.deaths)}</td>
								<td class="num">{kd(p.kills, p.deaths)}</td>
								<td class="num">{p.headshots} · {pct(p.headshots, p.kills)}</td>
								<td class="num">{p.teamKills}</td>
								<td class="num">{p.avgDistanceM === null ? '—' : `${p.avgDistanceM} m`}</td>
							</tr>
						{:else}
							<tr
								><td colspan="7" class="py-6 text-center text-mist-600">No kills in this range.</td
								></tr
							>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<div class="panel">
		<span class="label-sm">Matches</span>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<SortHeader sort={matchSort} key="started">Started</SortHeader>
						<SortHeader sort={matchSort} key="map">Map</SortHeader>
						<SortHeader sort={matchSort} key="mode">Mode &amp; mods</SortHeader>
						<SortHeader sort={matchSort} key="length" num>Length</SortHeader>
						<SortHeader sort={matchSort} key="peak" num>Peak</SortHeader>
						<SortHeader sort={matchSort} key="result">Result</SortHeader>
					</tr>
				</thead>
				<tbody>
					{#each matchRows as m (m.id)}
						<tr>
							<td class="whitespace-nowrap">{fmtTime(m.startedAt)}</td>
							<td>{m.map ? mapLabel(data.catalog, m.map) : '—'}</td>
							<td>{expSetLabel(data.catalog, m.experiences ? m.experiences.split('+') : [])}</td>
							<td class="num"
								>{duration(m.startedAt, m.endedAt)}{#if !m.endedAt}<Badge tone="info" class="ml-1"
										>live</Badge
									>{/if}</td
							>
							<td class="num">{m.peakPlayers}</td>
							<td>
								{#if m.finalScores}
									{#if m.winner}<b>{m.winner}</b> ·
									{/if}<span class="text-mist-400"
										>{m.finalScores.map((s) => `${s.name} ${s.score}`).join(' · ')}</span
									>
								{:else}<span class="text-mist-600">—</span>{/if}
							</td>
						</tr>
					{:else}
						<tr
							><td colspan="6" class="py-6 text-center text-mist-600"
								>No matches recorded in this range.</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			Match boundaries are inferred from the match clock and map changes between samples, so lengths
			are accurate to one polling interval.
		</p>
	</div>
{/if}
