<script lang="ts">
	// A column header that re-sorts the table when clicked, with an arrow on the column in force.
	// The caller owns the sort state, so this works for a table sorted in the page (lib/sort.ts)
	// and for one sorted in Postgres behind a query string (the organisation's player list) alike.
	import type { SortDir } from '$lib/sort';

	let {
		label,
		active = false,
		dir = 'asc',
		class: cls = '',
		onsort
	}: {
		label: string;
		/** is the table sorted by this column right now? */
		active?: boolean;
		dir?: SortDir;
		class?: string;
		onsort: () => void;
	} = $props();
</script>

<th class={cls} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
	<button type="button" class="th-sort" onclick={onsort}
		>{label}{#if active}<span aria-hidden="true">{dir === 'asc' ? ' ↑' : ' ↓'}</span>{/if}</button
	>
</th>

<style>
	.th-sort {
		cursor: pointer;
		font: inherit;
		color: inherit;
		text-transform: inherit;
		letter-spacing: inherit;
		background: none;
		border: 0;
		padding: 0;
	}
	.th-sort:hover {
		color: var(--color-accent, inherit);
	}
</style>
