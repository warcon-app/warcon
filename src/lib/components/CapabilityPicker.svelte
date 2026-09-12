<script lang="ts">
	// Checkboxes for one capability set, grouped the way the role editor and the API-key form
	// both show them. `locked` capabilities render checked and cannot be cleared (a role must keep
	// 'View'); pass none for an API key, which may be narrower than any role.
	import { CAPABILITY_INFO, capabilitiesByGroup, type Capability } from '$lib/capabilities';

	let {
		value = $bindable([]),
		locked = [],
		disabled = false,
		compact = false
	}: {
		value: Capability[];
		locked?: Capability[];
		disabled?: boolean;
		/** labels only, no hints: for a dense grid */
		compact?: boolean;
	} = $props();

	const groups = capabilitiesByGroup();
	const has = (c: Capability) => value.includes(c);
	function toggle(c: Capability, on: boolean) {
		if (locked.includes(c)) return;
		value = on ? [...value.filter((v) => v !== c), c] : value.filter((v) => v !== c);
	}
</script>

<div class="grid gap-3 {compact ? '' : 'sm:grid-cols-2'}">
	{#each groups as { group, caps } (group.key)}
		<fieldset class="min-w-0">
			<legend class="mb-1 caps text-mist-400" title={group.hint}>{group.label}</legend>
			{#each caps as c (c)}
				{@const isLocked = locked.includes(c)}
				<label
					class="flex items-start gap-2 py-0.5 text-[13px] {disabled || isLocked
						? 'text-mist-400'
						: 'cursor-pointer'}"
					title={CAPABILITY_INFO[c].hint}
				>
					<input
						type="checkbox"
						class="mt-0.5"
						checked={has(c) || isLocked}
						disabled={disabled || isLocked}
						onchange={(e) => toggle(c, (e.currentTarget as HTMLInputElement).checked)}
					/>
					<span class="min-w-0">
						{CAPABILITY_INFO[c].label}
						{#if !compact}<span class="block text-[12px] text-mist-600"
								>{CAPABILITY_INFO[c].hint}</span
							>{/if}
					</span>
				</label>
			{/each}
		</fieldset>
	{/each}
</div>
