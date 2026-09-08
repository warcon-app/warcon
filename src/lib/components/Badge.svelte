<script lang="ts">
	import type { Snippet } from 'svelte';
	export type Tone = '' | 'ok' | 'err' | 'info' | 'accent' | 'warn';
	let {
		tone = '',
		class: cls = '',
		children
	}: { tone?: Tone; class?: string; children: Snippet } = $props();
	const TONES: Record<Tone, string> = {
		'': '',
		ok: 'bg-ok/15 text-ok',
		err: 'bg-danger/15 text-danger',
		info: 'bg-info/15 text-info',
		accent: 'border-accent/40 bg-accent/15 text-accent',
		warn: 'bg-warn/15 text-warn'
	};
</script>

<span class="badge {TONES[tone]} {cls}">{@render children()}</span>
