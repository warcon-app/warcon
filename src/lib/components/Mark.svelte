<script lang="ts">
	let { size = 28 }: { size?: number } = $props();
</script>

<!-- Brass plate with a cut corner and a target reticle: flat, no gradients. -->
<span
	class="inline-flex shrink-0 items-center justify-center bg-accent text-ink-950"
	style="width:{size}px;height:{size}px;clip-path:polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px))"
	aria-hidden="true"
>
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.2"
		stroke-linecap="square"
		style="width:{size * 0.62}px;height:{size * 0.62}px"
	>
		<circle cx="12" cy="12" r="6" />
		<path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
		<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
	</svg>
</span>
