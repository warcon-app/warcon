<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		title = '',
		wide = false,
		onclose,
		children,
		actions
	}: {
		title?: string;
		wide?: boolean;
		onclose: () => void;
		children: Snippet;
		actions?: Snippet;
	} = $props();

	let box: HTMLDivElement | undefined = $state();

	$effect(() => {
		const first = box?.querySelector<HTMLElement>(
			'input:not([type=hidden]):not([disabled]), textarea, select, button:not([data-close])'
		);
		first?.focus();
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window {onkeydown} />

<div class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
	<button
		type="button"
		class="absolute inset-0 cursor-default bg-black/70"
		aria-label="Close dialog"
		data-close
		onclick={onclose}
	></button>
	<div
		bind:this={box}
		class="relative max-h-[calc(100dvh-1.5rem)] w-full rise overflow-y-auto panel shadow-pop {wide
			? 'max-w-3xl'
			: 'max-w-lg'}"
		role="dialog"
		aria-modal="true"
		aria-label={title || 'Dialog'}
	>
		{#if title}<h3 class="mb-4 text-[15px] font-semibold">{title}</h3>{/if}
		{@render children()}
		{#if actions}<div class="mt-5 flex flex-wrap justify-end gap-2">{@render actions()}</div>{/if}
	</div>
</div>
