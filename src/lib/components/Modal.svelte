<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		title = '',
		label = '',
		wide = false,
		back,
		onclose,
		children,
		actions
	}: {
		title?: string;
		/** names the dialog when its content draws its own heading in place of `title` */
		label?: string;
		/** `'xl'`: wider still and held at the top, for a grid of choices */
		wide?: boolean | 'xl';
		/** a way back to the step that opened this one, shown above the title */
		back?: { label: string; onclick: () => void };
		onclose: () => void;
		children: Snippet;
		actions?: Snippet;
	} = $props();

	let box: HTMLDivElement | undefined = $state();

	const FOCUSABLE =
		'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

	// Focus the first field on open and hand focus back to whatever opened the dialog on close.
	$effect(() => {
		const opener = document.activeElement as HTMLElement | null;
		const first = box?.querySelector<HTMLElement>(
			'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([data-close]):not([disabled])'
		);
		first?.focus();
		return () => {
			if (opener?.isConnected) opener.focus();
		};
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onclose();
			return;
		}
		// Keep Tab inside the dialog: the page behind it is not interactive while it is open.
		if (e.key === 'Tab' && box) {
			const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || !box.contains(active))) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (active === last || !box.contains(active))) {
				e.preventDefault();
				first.focus();
			}
		}
	}
</script>

<svelte:window {onkeydown} />

<!-- An 'xl' dialog keeps its top edge where it opened, so a list it filters shrinks from the bottom. -->
<div
	class="fixed inset-0 z-50 flex justify-center p-3 sm:p-4 {wide === 'xl'
		? 'items-start sm:pt-10'
		: 'items-center'}"
>
	<button
		type="button"
		class="absolute inset-0 cursor-default bg-black/70"
		aria-label="Close dialog"
		data-close
		tabindex="-1"
		onclick={onclose}
	></button>
	<div
		bind:this={box}
		class="relative max-h-[calc(100dvh-1.5rem)] w-full rise overflow-y-auto panel shadow-pop {wide ===
		'xl'
			? 'max-w-5xl sm:max-h-[calc(100dvh-3.5rem)]'
			: wide
				? 'max-w-3xl'
				: 'max-w-lg'}"
		role="dialog"
		aria-modal="true"
		aria-label={label || title || 'Dialog'}
	>
		<!-- data-close: the first field still takes the focus on open, not the way back -->
		{#if back}<button
				type="button"
				class="mb-2.5 block cursor-pointer caps text-mist-400 hover:text-mist-100"
				data-close
				onclick={back.onclick}>← {back.label}</button
			>{/if}
		{#if title}<h3 class="mb-4 text-[15px] font-semibold">{title}</h3>{/if}
		{@render children()}
		{#if actions}<div class="mt-5 flex flex-wrap justify-end gap-2">{@render actions()}</div>{/if}
	</div>
</div>
