<script lang="ts">
	// The reserved-slot lists of an organisation as a strip: its own list, then each group with
	// whether it is on, set for later or off, and a way to make another.
	import { groupState } from '$lib/lists';
	import GroupDialog from './GroupDialog.svelte';
	import type { OrgListsView } from '$lib/types';

	let {
		org,
		lists,
		current
	}: {
		org: { id: string; name: string };
		lists: OrgListsView;
		/** the group shown, or null for the organisation's own list */
		current: string | null;
	} = $props();

	let base = $derived(`/orgs/${encodeURIComponent(org.id)}/reserved`);
	let own = $derived(lists.lists.find((l) => l.kind === 'reserve')?.entryCount ?? 0);
	let making = $state(false);

	const pill =
		'inline-flex h-9 shrink-0 items-center gap-2 rounded-ctl border px-3 text-[13px] font-medium whitespace-nowrap sm:h-[34px]';
	const idle = 'border-black bg-ink-900 hover:border-white/15';
	const active = 'border-accent bg-accent/10 font-semibold';
</script>

<nav class="strip mb-4 gap-1.5" aria-label="Reserved-slot lists">
	<a
		href={base}
		class="{pill} {current === null ? active : idle}"
		aria-current={current === null ? 'page' : undefined}
		>Organisation list <span class="text-mist-400 tabular">{own}</span></a
	>
	{#each lists.groups as g (g.id)}
		{@const s = groupState(g)}
		<a
			href="{base}/{encodeURIComponent(g.id)}"
			class="{pill} {current === g.id ? active : idle} {s.kind === 'off' && current !== g.id
				? 'text-mist-400'
				: ''}"
			aria-current={current === g.id ? 'page' : undefined}
			title="{g.name}: {s.text}"
		>
			{#if s.kind === 'on'}
				<span class="size-[7px] rounded-full bg-ok" aria-label="on"></span>
			{:else if s.kind === 'later'}
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					class="size-3 text-info"
					aria-label="set for later"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg
				>
			{:else}
				<span class="size-[7px] rounded-full border-[1.5px] border-mist-600" aria-label="off"
				></span>
			{/if}
			{g.name} <span class="text-mist-400 tabular">{g.entryCount}</span>
		</a>
	{/each}
	<button type="button" class="btn btn-sm shrink-0 btn-ghost" onclick={() => (making = true)}
		>+ New group</button
	>
</nav>

{#if making}
	<GroupDialog {org} servers={lists.servers} mode="create" onclose={() => (making = false)} />
{/if}
