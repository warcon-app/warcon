<script lang="ts">
	// A list of things (servers, or people) each with a role toggle: the body of the access
	// dialogs. Grows a filter box past a handful of rows, and a "set all" row that applies to
	// whatever the filter currently shows.
	import RoleToggle from './RoleToggle.svelte';

	type Row = { id: string; label: string; sub?: string };
	let {
		rows,
		grants = $bindable(),
		empty = 'Nothing to grant yet.'
	}: { rows: Row[]; grants: Record<string, string>; empty?: string } = $props();

	let q = $state('');
	let shown = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		if (!needle) return rows;
		return rows.filter((r) => `${r.label} ${r.sub ?? ''}`.toLowerCase().includes(needle));
	});
	/** the role every shown row shares, or null when they differ */
	let common = $derived.by(() => {
		if (!shown.length) return null;
		const first = grants[shown[0].id] ?? '';
		return shown.every((r) => (grants[r.id] ?? '') === first) ? first : null;
	});
	function setAll(v: string) {
		for (const r of shown) grants[r.id] = v;
	}
</script>

{#if rows.length}
	{#if rows.length > 6}
		<input
			class="mb-2 input"
			type="search"
			placeholder="Filter…"
			bind:value={q}
			aria-label="Filter"
		/>
	{/if}
	<div class="kv items-center border-b border-white/10 text-mist-400">
		<span class="caps"
			>{#if shown.length !== rows.length}{shown.length} of {rows.length} ·
			{/if}set all</span
		>
		<RoleToggle value={common} label="Set every shown row" onchange={setAll} />
	</div>
	<div class="max-h-[55dvh] overflow-y-auto">
		{#each shown as r (r.id)}
			<div class="kv items-center">
				<span class="min-w-0 truncate"
					>{r.label}
					{#if r.sub}<span class="font-mono text-[12px] text-mist-600">{r.sub}</span>{/if}</span
				>
				<RoleToggle bind:value={grants[r.id]} label={r.label} />
			</div>
		{:else}
			<p class="py-3 text-center text-mist-600">Nothing matches.</p>
		{/each}
	</div>
	<p class="note">– none · V viewer · O operator · A admin</p>
{:else}
	<p class="text-mist-400">{empty}</p>
{/if}
