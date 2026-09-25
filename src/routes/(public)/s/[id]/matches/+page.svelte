<script lang="ts">
	// The public match history, one page of cards at a time; the pager is plain links, so any
	// page can be shared.
	import MatchCards from '$lib/components/MatchCards.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let base = $derived(`/s/${encodeURIComponent(data.heading.id)}`);
	let list = $derived(data.list);
	const pageHref = (p: number) => (p > 1 ? `${base}/matches?page=${p}` : `${base}/matches`);
</script>

<svelte:head>
	<title>Matches · {data.heading.name} · {data.appName}</title>
	<meta name="description" content="Match history of {data.heading.name}." />
</svelte:head>

<div class="rise">
	<MatchCards matches={list.matches} live={list.live} hrefFor={(m) => m.endedAt ? `${base}/matches/${m.id}` : data.heading.features.status ? base : undefined } />
	{#if list.pages > 1}
		<div class="mt-4 flex items-center gap-2 text-[12.5px] text-mist-400">
			{#if list.page > 1}<a href={pageHref(list.page - 1)} class="btn btn-sm">← Newer</a
				>{:else}<span class="pointer-events-none btn btn-sm opacity-50">← Newer</span>{/if}
			<span>Page {list.page} of {list.pages}</span>
			{#if list.page < list.pages}<a href={pageHref(list.page + 1)} class="btn btn-sm">Older →</a
				>{:else}<span class="pointer-events-none btn btn-sm opacity-50">Older →</span>{/if}
		</div>
	{/if}
	<p class="note">
		A match opens to its scoreboard once it has ended; the one in progress is on the live page.
	</p>
</div>
