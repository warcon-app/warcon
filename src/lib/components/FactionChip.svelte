<script lang="ts">
	import { factionColor } from '$lib/format';
	import type { FactionScore } from '$lib/types';
	let { faction, scores }: { faction: string | null | undefined; scores?: FactionScore[] | null } =
		$props();
</script>

{#if faction}
	<span class="inline-flex items-center gap-1.5">
		<span
			class="inline-block h-2.5 w-2.5 rounded-full"
			style="background:{factionColor(faction, scores)}"
		></span>{faction}
	</span>
{:else}
	<span class="text-mist-600">unassigned</span>
{/if}
