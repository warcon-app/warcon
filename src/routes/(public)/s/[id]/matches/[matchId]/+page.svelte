<script lang="ts">
	// A public match page: the match panel as the dossier shows it, names linking to public
	// careers, and the match's kill feed as the live page shows kills (names and factions only).
	import { api, qs } from '$lib/api';
	import MatchPanel from '$lib/components/MatchPanel.svelte';
	import { causeLabel } from '$lib/causes';
	import { factionColor, fmtDuration, mapName } from '$lib/format';
	import type { PublicKill } from '$lib/server/public';
	import type { PageProps } from './$types';
	import LeaderboardTable from '$lib/components/LeaderboardTable.svelte';

	let { data }: PageProps = $props();
	let base = $derived(`/s/${encodeURIComponent(data.heading.id)}`);
	let view = $derived(data.match);
	// Older kills pile up under the load's first page; another match starts over.
	let extra = $state<PublicKill[]>([]);
	let extraMore = $state<boolean | null>(null);
	let more = $derived(extraMore ?? data.more);
	let loading = $state(false);
	let feed = $derived([...data.feed, ...extra]);
	$effect(() => {
		void view.match.id;
		extra = [];
		extraMore = null;
	});

	async function older() {
		const last = feed[feed.length - 1];
		if (!last) return;
		loading = true;
		try {
			const r = await api<{ feed: PublicKill[]; more: boolean }>(
				'GET',
				`/api/public/servers/${encodeURIComponent(data.heading.id)}/matches/${view.match.id}${qs({
					before: last.ts,
					beforeTime: last.eventTime
				})}`
			);
			extra = [...extra, ...r.feed];
			extraMore = r.more;
		} catch {
			/* the page keeps what it has */
		} finally {
			loading = false;
		}
	}
	const colorOf = (faction: string | null) =>
		view.factions.find((f) => f.name === faction)?.colorHex || factionColor(faction);
	const causeText = (k: PublicKill) =>
		causeLabel(k.cause) || (k.tags.includes('Falling') ? 'Fall' : '—');
</script>

<svelte:head>
	<title>{mapName(view.match.map)} · {data.heading.name} · {data.appName}</title>
	<meta name="description" content="A match on {data.heading.name}: {mapName(view.match.map)}." />
</svelte:head>

<div class="rise">
	<a href="{base}/matches" class="caps text-mist-400 hover:text-mist-100">← Matches</a>
	<div class="mt-3 panel">
		<MatchPanel {view} hrefFor={(steamId) => data.heading.features.leaderboards ? `${base}/players/${steamId}` : undefined } />
		{#if view.kills}
			<span class="mt-4 field-label">Kill feed · {view.kills}</span>
			<div class="table-wrap">
				<table>
					<thead>
						<tr
							><th>Clock</th><th>Killer</th><th>Victim</th><th>With</th><th class="num">Range</th
							></tr
						>
					</thead>
					<tbody>
						{#each feed as k (k.eventId)}
							<tr>
								<td class="font-mono text-[12px] whitespace-nowrap text-mist-400"
									>{fmtDuration(k.eventTime)}</td
								>
								<td>
									{#if k.killer}
										<span style="color:{colorOf(k.killer.faction)}">{k.killer.name}</span>
									{:else}<span class="text-mist-600">—</span>{/if}
								</td>
								<td>
									<span style="color:{colorOf(k.victim.faction)}">{k.victim.name}</span>
									{#if k.teamKill}<span class="chip">team kill</span>{/if}
									{#if k.suicide}<span class="chip">suicide</span>{/if}
									{#if k.headshot}<span class="chip">headshot</span>{/if}
								</td>
								<td class="text-mist-400">{causeText(k)}</td>
								<td class="num text-mist-400"
									>{k.distanceM === null ? '—' : `${Math.round(k.distanceM)} m`}</td
								>
							</tr>
						{:else}
							<tr
								><td colspan="5" class="py-4 text-center text-mist-600"
									>No kills of this match were received.</td
								></tr
							>
						{/each}
					</tbody>
				</table>
			</div>
			{#if more}
				<button class="mt-3 btn" onclick={older} disabled={loading}>
					{loading ? 'Loading…' : 'Load older kills'}
				</button>
			{/if}
		{/if}
	</div>
</div>
