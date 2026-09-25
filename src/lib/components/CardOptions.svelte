<script lang="ts">
	// How often a status card is edited and what it links to. The server's Settings tab and the
	// org page's webhook dialog share these fields so both ask in the same words.
	import type { FeatureSet } from '$lib/features';

	let {
		interval = $bindable(),
		linkStatus = $bindable(),
		linkLeaderboard = $bindable(),
		linkPanel = $bindable(),
		linkMatches = $bindable(),
		/** the one server's public pages, when the card is for one server; null across an org */
		features = null
	}: {
		interval: number;
		linkStatus: boolean;
		linkLeaderboard: boolean;
		linkPanel: boolean;
		linkMatches: boolean;
		features?: FeatureSet | null;
	} = $props();

	const INTERVALS = [
		[30, '30 seconds'],
		[45, '45 seconds'],
		[60, '1 minute'],
		[90, '90 seconds'],
		[120, '2 minutes'],
		[180, '3 minutes'],
		[300, '5 minutes']
	] as const;
	const off = (on: boolean | undefined) => on === false;
</script>

<label class="block sm:w-60"
	><span class="field-label">Refresh</span><select class="input" bind:value={interval}>
		{#each INTERVALS as [s, label] (s)}<option value={s}>Every {label}</option>{/each}
	</select></label
>
<div>
	<span class="field-label">Links on the card</span>
	<div class="flex flex-wrap gap-x-6 gap-y-2">
		<label class="flex items-center gap-2 text-[13px]"
			><input type="checkbox" bind:checked={linkStatus} /> Live status page{#if off(features?.status)}
				<span class="text-mist-600">(page is off)</span>{/if}</label
		>
		<label class="flex items-center gap-2 text-[13px]"
			><input type="checkbox" bind:checked={linkLeaderboard} />
			Leaderboard{#if off(features?.leaderboards)}
				<span class="text-mist-600">(page is off)</span>{/if}</label
		>
		<label class="flex items-center gap-2 text-[13px]"
			><input type="checkbox" bind:checked={linkMatches} />
			Matches{#if off(features?.matches)}
				<span class="text-mist-600">(page is off)</span>{/if}</label
		>
		<label class="flex items-center gap-2 text-[13px]"
			><input type="checkbox" bind:checked={linkPanel} /> Panel (needs a sign-in)</label
		>
	</div>
	<p class="note">
		The title opens the first link, the rest sit under the card. A public link goes out only while
		that page is on for the server (under Public pages), so a card never sends people to the sign-in
		wall. Edits wait at least the refresh interval, longer when many servers share one webhook.
	</p>
</div>
