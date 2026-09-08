<script lang="ts">
	import { toasts, dismiss } from '$lib/toast.svelte';
</script>

<div
	class="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
	aria-live="polite"
>
	{#each toasts as t (t.id)}
		<button
			type="button"
			class="pointer-events-auto rise rounded-ctl border px-4 py-3 text-left text-[13.5px] leading-snug shadow-pop
				{t.kind === 'ok'
				? 'border-ok/30 bg-ok/15 text-ok'
				: t.kind === 'err'
					? 'border-danger/30 bg-danger/15 text-danger'
					: 'border-black bg-ink-800 text-mist-100'}"
			onclick={() => dismiss(t.id)}
		>
			{t.message}
		</button>
	{/each}
</div>
