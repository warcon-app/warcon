<script lang="ts">
	import { mapArtCandidates, type MapArtVariant } from '$lib/map-art';

	let {
		map,
		lighting = '',
		variant = '720',
		alt = '',
		class: cls = ''
	}: {
		map: string | null | undefined;
		lighting?: string | null;
		variant?: MapArtVariant;
		alt?: string;
		class?: string;
	} = $props();

	let candidates = $derived(mapArtCandidates(map, lighting, variant));
	let key = $derived(candidates.join('|'));
	// How far down the candidate list load errors have pushed us, for the current selection only:
	// progress recorded against another key is ignored, so a new selection starts from the top.
	let progress = $state({ key: '', attempt: 0, failed: false });
	let cur = $derived(progress.key === key ? progress : { key, attempt: 0, failed: false });
	let src = $derived(cur.failed ? '' : candidates[cur.attempt]);

	function onerror() {
		const next = cur.attempt + 1;
		progress =
			next < candidates.length
				? { key, attempt: next, failed: false }
				: { key, attempt: cur.attempt, failed: true };
	}
</script>

{#if src}
	<img {src} {alt} class="map-art map-art-{variant} {cls}" loading="lazy" {onerror} />
{/if}
