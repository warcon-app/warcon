<script lang="ts">
	// Four-state server role control: none / viewer / operator / admin, one letter each so a
	// grid of them stays compact. `value` null shows nothing selected (a mixed set).
	let {
		value = $bindable(''),
		disabled = false,
		label = 'Server role',
		onchange
	}: {
		value?: string | null;
		disabled?: boolean;
		label?: string;
		onchange?: (value: string) => void;
	} = $props();

	const OPTIONS: [string, string, string][] = [
		['', '–', 'no access'],
		['viewer', 'V', 'viewer'],
		['operator', 'O', 'operator'],
		['admin', 'A', 'admin']
	];
	const ACTIVE: Record<string, string> = {
		'': 'bg-ink-700 text-mist-100',
		viewer: 'bg-white/15 text-mist-100',
		operator: 'bg-info/25 text-info',
		admin: 'bg-accent text-ink-950'
	};

	function pick(v: string) {
		value = v;
		onchange?.(v);
	}
</script>

<span
	class="inline-flex overflow-hidden rounded-ctl border border-black bg-ink-950 align-middle"
	role="radiogroup"
	aria-label={label}
>
	{#each OPTIONS as [v, short, title] (v)}
		<button
			type="button"
			role="radio"
			aria-checked={value === v}
			title="{label}: {title}"
			class="h-6 w-7 border-r border-black text-[10.5px] font-bold transition last:border-r-0 disabled:cursor-not-allowed disabled:opacity-40 {value ===
			v
				? ACTIVE[v]
				: 'text-mist-600 hover:bg-ink-800 hover:text-mist-100'}"
			onclick={() => pick(v)}
			{disabled}>{short}</button
		>
	{/each}
</span>
