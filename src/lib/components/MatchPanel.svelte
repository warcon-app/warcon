<script lang="ts">
	// A match as its page shows it, in the panel and on the public site: the header (map, mode,
	// when, how long, how many), the final scores, the score over time, the awards and the
	// scoreboard: every player's line, sortable, kills first. The page renders the match's kill
	// feed under it.
	import SortHeader from '$lib/components/SortHeader.svelte';
	import FactionChip from '$lib/components/FactionChip.svelte';
	import ScoreTimeline from '$lib/components/ScoreTimeline.svelte';
	import { fmtCash } from '$lib/cash';
	import { expSetLabel, factionColor, fmtNum, fmtTime, mapName, prettify } from '$lib/format';
	import { kdRatio } from '$lib/leaderboard';
	import { DEFAULT_SCORE_CAP } from '$lib/match';
	import { durationOf, fmtLength, perMinute, type MatchLine, type MatchView } from '$lib/matches';
	import { TableSort } from '$lib/table.svelte';

	let {
		view,
		hrefFor,
		showIds = false
	}: {
		view: MatchView;
		/** where a player's name goes: the dossier, or the public career */
		hrefFor: (steamId: string) => string | undefined;
		showIds?: boolean;
	} = $props();

	const NO_CATALOG = { maps: [], lightings: [], experiences: [] };
	let m = $derived(view.match);
	let length = $derived(durationOf(m));
	let mode = $derived(
		[
			m.experiences ? expSetLabel(NO_CATALOG, m.experiences.split('+')) : '',
			m.lighting ? prettify(m.lighting) : ''
		]
			.filter(Boolean)
			.join(' · ')
	);
	let scores = $derived([...(m.finalScores ?? [])].sort((a, b) => b.score - a.score));
	let cap = $derived(Math.max(DEFAULT_SCORE_CAP, ...scores.map((f) => f.score)));
	const colorOf = (name: string | null) =>
		view.factions.find((f) => f.name === name)?.colorHex || factionColor(name);
	const kd = (l: MatchLine) => kdRatio(l.kills, l.deaths);
	const kpm = (l: MatchLine) => perMinute(l.kills, l.seconds);
	const ratio = (v: number | null, digits = 2) => (v === null ? '—' : v.toFixed(digits));
	const sort = new TableSort<MatchLine>(
		{
			name: { by: (l) => l.name },
			faction: { by: (l) => l.faction },
			seconds: { by: (l) => l.seconds, dir: 'desc' },
			kills: { by: (l) => l.kills, dir: 'desc' },
			deaths: { by: (l) => l.deaths, dir: 'desc' },
			kd: { by: kd, dir: 'desc' },
			kpm: { by: kpm, dir: 'desc' },
			cash: { by: (l) => l.cashDelta, dir: 'desc' },
			headshots: { by: (l) => l.headshots, dir: 'desc' },
			teamKills: { by: (l) => l.teamKills, dir: 'desc' },
			vehicleKills: { by: (l) => l.vehicleKills, dir: 'desc' },
			streak: { by: (l) => l.killStreak, dir: 'desc' }
		},
		{ key: 'kills', dir: 'desc' }
	);
	let rows = $derived(sort.sorted(view.lines));
	const RESULT = { win: 'text-ok', loss: 'text-danger', draw: 'text-mist-400' } as const;
</script>

<div class="flex flex-wrap items-end justify-between gap-3">
	<div class="min-w-0">
		<h2 class="text-2xl font-semibold">{mapName(m.map)}</h2>
		<div class="mt-1 caps text-mist-400">
			{#if mode}{mode} ·
			{/if}Started {fmtTime(m.startedAt)} · {fmtLength(length)} · {fmtNum(m.peakPlayers)} at peak · {fmtNum(
				m.players
			)} played
		</div>
	</div>
	{#if m.winner}
		<div class="text-right">
			<div class="caps text-mist-400">Winner</div>
			<div class="font-display text-2xl font-semibold" style="color:{colorOf(m.winner)}">
				{m.winner}
			</div>
		</div>
	{:else if scores.length}
		<div class="caps text-mist-400">Draw</div>
	{:else}
		<div class="caps text-mist-600">Abandoned: closed by a restart, no result</div>
	{/if}
</div>

{#if scores.length}
	<div
		class="mt-4 grid gap-2 sm:grid-cols-[repeat(var(--n),minmax(0,1fr))]"
		style="--n:{scores.length}"
	>
		{#each scores as f (f.name)}
			<div class="rounded-ctl border border-black bg-ink-950 px-3.5 py-3">
				<div class="flex items-baseline justify-between gap-2">
					<span class="truncate caps" style="color:{colorOf(f.name)}">{f.name}</span>
					<span
						class="font-display text-2xl leading-none font-semibold tabular {f.name === m.winner
							? 'text-mist-100'
							: 'text-mist-400'}">{fmtNum(f.score)}</span
					>
				</div>
				<div class="mt-2 progress">
					<span
						class="progress-bar"
						style="width:{Math.min(100, Math.round((f.score / cap) * 100))}%; background:{colorOf(
							f.name
						)}"
					></span>
				</div>
			</div>
		{/each}
	</div>
{/if}

<div class="mt-4 rounded-ctl border border-black bg-ink-950 px-3.5 py-3">
	<span class="caps text-mist-400">Score over the match</span>
	<div class="mt-2">
		<ScoreTimeline points={view.timeline} factions={view.factions} durationSeconds={length} />
	</div>
</div>

{#if view.awards.length}
	<div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
		{#each view.awards as a (a.key)}
			{@const href = hrefFor(a.steamId)}
			<div class="rounded-ctl border border-black bg-ink-950 px-3.5 py-3">
				<div class="caps text-mist-400">{a.label}</div>
				<div class="mt-1 font-display text-xl font-semibold tabular">{a.value}</div>

				{#if href}
					<a
						href={href}
						class="block truncate text-[12.5px] text-mist-400 hover:text-accent hover:underline"
						>{a.name}</a>
				{:else}
					<span class="block truncate text-[12.5px] text-mist-400">{a.name}</span>
				{/if}

			</div>
		{/each}
	</div>
{/if}

<div class="mt-4 table-wrap">
	<table>
		<thead>
			<tr>
				<SortHeader {sort} key="name">Player</SortHeader>
				<SortHeader {sort} key="faction">Faction</SortHeader>
				<SortHeader {sort} key="seconds" num title="Time on during the match">Time</SortHeader>
				<SortHeader {sort} key="kills" num>K</SortHeader>
				<SortHeader {sort} key="deaths" num>D</SortHeader>
				<SortHeader {sort} key="kd" num>K/D</SortHeader>
				<SortHeader {sort} key="kpm" num title="Kills per minute of time on">K/min</SortHeader>
				<SortHeader {sort} key="cash" num title="The change in the player's cash over the match"
					>Cash</SortHeader
				>
				{#if view.hasFeed}
					<SortHeader {sort} key="headshots" num title="Headshots">HS</SortHeader>
					<SortHeader {sort} key="teamKills" num title="Team kills">TK</SortHeader>
					<SortHeader {sort} key="vehicleKills" num title="Kills with a vehicle">VK</SortHeader>
					<SortHeader {sort} key="streak" num title="Best kill streak">Streak</SortHeader>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each rows as l (l.steamId)}
				{@const href = hrefFor(l.steamId)}
				<tr>
					<td>
						{#if href}
						<a href={hrefFor(l.steamId)} class="hover:text-accent hover:underline">{l.name}</a>
						{:else}
						<span >{l.name}</span>
						{/if}
						{#if showIds}<span class="block font-mono text-[11px] text-mist-600">{l.steamId}</span
							>{/if}
					</td>
					<td class="whitespace-nowrap">
						<FactionChip
							faction={l.faction}
							scores={view.factions.map((f) => ({ ...f, colorHex: f.colorHex ?? '', score: 0 }))}
						/>
						{#if l.result}<span class="ml-1 text-[11px] {RESULT[l.result]}">{l.result}</span>{/if}
					</td>
					<td class="num whitespace-nowrap">{fmtLength(l.seconds)}</td>
					<td class="num">{fmtNum(l.kills)}</td>
					<td class="num">{fmtNum(l.deaths)}</td>
					<td class="num">{ratio(kd(l))}</td>
					<td class="num">{ratio(kpm(l))}</td>
					<td class="num {l.cashDelta > 0 ? 'text-ok' : l.cashDelta < 0 ? 'text-danger' : ''}"
						>{l.cashDelta > 0 ? '+' : ''}{fmtCash(l.cashDelta)}</td
					>
					{#if view.hasFeed}
						<td class="num">{l.headshots}</td>
						<td class="num {l.teamKills >= 3 ? 'text-warn' : ''}">{l.teamKills}</td>
						<td class="num">{l.vehicleKills}</td>
						<td class="num">{l.killStreak}</td>
					{/if}
				</tr>
			{:else}
				<tr
					><td colspan="12" class="py-6 text-center text-mist-600"
						>Nobody was recorded in this match.</td
					></tr
				>
			{/each}
		</tbody>
	</table>
</div>
