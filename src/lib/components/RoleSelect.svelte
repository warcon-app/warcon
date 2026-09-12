<script lang="ts">
	// Picks one of an organisation's server roles, or none. `value` is the role id ('' = no
	// access); null shows a blank choice for a mixed set. Roles come from the org: they differ
	// per organisation and owners may add their own.
	type RoleOption = { id: string; name: string };
	let {
		value = $bindable(''),
		roles,
		disabled = false,
		label = 'Server role',
		none = 'no access',
		mixed = false,
		onchange
	}: {
		value?: string | null;
		roles: RoleOption[];
		disabled?: boolean;
		label?: string;
		/** the label of the empty choice; '' hides it (a role is required) */
		none?: string;
		/** show a blank entry for "these differ" when value is null */
		mixed?: boolean;
		onchange?: (value: string) => void;
	} = $props();

	function pick(e: Event) {
		const v = (e.currentTarget as HTMLSelectElement).value;
		value = v;
		onchange?.(v);
	}
</script>

<select class="input-sm input" aria-label={label} {disabled} value={value ?? ''} onchange={pick}>
	{#if mixed && value === null}<option value="">–</option>{/if}
	{#if none}<option value="">{none}</option>{/if}
	{#each roles as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
</select>
