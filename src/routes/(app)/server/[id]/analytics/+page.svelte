<script lang="ts">
	import { api, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { fmtNum, fmtTime, mapLabel, expSetLabel } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import PopulationChart from '$lib/components/PopulationChart.svelte';
	import type { Analytics, Range } from '$lib/server/analytics';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let range = $state<Range>('24h');
	let a = $state<Analytics | null>(null);
	let loading = $state(false);
	let view = $state<'chart' | 'table'>('chart');

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

	const RANGES: { key: Range; label: string }[] = [
		{ key: '24h', label: '24 hours' },
		{ key: '7d', label: '7 days' },
		{ key: '30d', label: '30 days' }
	];
	const minutes = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
	const duration = (from: string, to: string | null) =>
		minutes(Math.round((Date.parse(to ?? new Date().toISOString()) - Date.parse(from)) / 60000));
	let maxMapMinutes = $derived(Math.max(1, ...(a?.maps.map((m) => m.minutes) ?? [])));
	let maxHourly = $derived(Math.max(1, ...(a?.hourly.map((h) => h.avg) ?? [])));
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
		{#if a}sampled every {a.pollSeconds}s · {fmtNum(a.summary.samples)} samples{#if loading}
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
			<span class="label-sm mb-0">Players online</span>
			<span class="text-[12px] text-mist-600"
				>average per {a.bucketSeconds / 60} min bucket · red bands are outages</span
			>
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
		{#if view === 'chart'}
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

	<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
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
			<span class="label-sm">Average players by hour (UTC)</span>
			{#if a.hourly.length}
				<div
					class="flex h-36 items-end gap-[3px]"
					role="img"
					aria-label="Average players by hour of day"
				>
					{#each Array.from({ length: 24 }, (_, h) => a!.hourly.find((x) => x.hour === h)?.avg ?? 0) as v, h (h)}
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
				<thead
					><tr
						><th>Player</th><th class="num">Playtime</th><th class="num">Sessions</th><th
							class="num">K</th
						><th class="num">D</th><th>Last seen</th></tr
					></thead
				>
				<tbody>
					{#each a.players as p (p.steamId)}
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

	<div class="panel">
		<span class="label-sm">Matches</span>
		<div class="table-wrap">
			<table>
				<thead
					><tr
						><th>Started</th><th>Map</th><th>Mode &amp; mods</th><th class="num">Length</th><th
							class="num">Peak</th
						><th>Result</th></tr
					></thead
				>
				<tbody>
					{#each a.matches as m (m.id)}
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
