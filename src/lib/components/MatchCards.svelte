<script lang="ts">
	// A server's matches as the public site lists them: one card per match with the map large,
	// the result as one bar split by faction in its colour with the winner tagged, and when it
	// started, how long it ran and how many played. A match that has ended is a link to its page;
	// the one in progress shows the scores as they stand.
	import { factionColor, fmtTime, mapName } from '$lib/format';
	import { page } from '$app/state';
	import {
		durationOf,
		fmtLength,
		resultLine,
		type LiveFaction,
		type MatchSummary
	} from '$lib/matches';

	let {
		matches,
		live = [],
		hrefFor
	}: {
		matches: MatchSummary[];
		live?: LiveFaction[];
		hrefFor: (m: MatchSummary) => string | undefined;
	} = $props();
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	const colorOf = (name: string | null) =>
		live.find((f) => f.name === name)?.colorHex || factionColor(name);
	const scoresOf = (m: MatchSummary) =>
		[...(m.endedAt ? (m.finalScores ?? []) : live)].sort((a, b) => b.score - a.score);
</script>

{#snippet card(m: MatchSummary)}
	{@const r = resultLine(m)}
	{@const scores = scoresOf(m)}
	{@const total = scores.reduce((n, f) => n + f.score, 0)}
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<div class="font-display text-[22px] leading-tight font-semibold tracking-[0.06em] uppercase">
			{mapName(m.map)}
		</div>
		<div class="caps">
			{#if r.kind === 'won' && m.winner}
				<span style="color:{colorOf(m.winner)}">{m.winner}</span>
				<span class="text-mist-400">· winner</span>
			{:else if r.kind === 'draw'}<span class="text-mist-400">Draw</span>
			{:else if r.kind === 'abandoned'}<span class="text-mist-600">Abandoned</span>
			{:else}<span class="text-mist-400">In progress</span>{/if}
		</div>
	</div>
	{#if scores.length && total > 0}
		<div class="mt-3 flex h-2 overflow-hidden rounded-[2px] bg-ink-800">
			{#each scores as f (f.name)}
				<span style="width:{(f.score / total) * 100}%; background:{colorOf(f.name)}"></span>
			{/each}
		</div>
		<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
			{#each scores as f (f.name)}
				<span class="inline-flex items-center gap-1.5">
					<span class="inline-block h-2 w-2 rounded-full" style="background:{colorOf(f.name)}"
					></span>
					{f.name}
					<span class="font-mono text-mist-400 tabular">{f.score}</span>
				</span>
			{/each}
		</div>
	{/if}
	<div class="mt-2 caps text-mist-400">
		Started {fmtTime(m.startedAt)} · {fmtLength(durationOf(m, now))} · {m.endedAt
			? m.players || m.peakPlayers
			: m.peakPlayers} played
	</div>
{/snippet}

<div class="grid gap-3">
	{#each matches as m (m.id)}
		{@const href = hrefFor(m)}
		{#if href}
			<a href={href} class="block panel py-4 transition-colors hover:border-mist-600">{@render card(m)}</a>
		{:else}
			<div class="panel py-4">{@render card(m)}</div>
		{/if}
	{:else}
		<div class="panel py-6 text-center text-mist-600">No matches recorded yet.</div>
	{/each}
</div>
