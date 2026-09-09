import { untrack } from 'svelte';

/** Last known reachability per server id, shown as the pulse dot in the switcher and dashboard. */
export const health = $state<Record<string, boolean>>({});

export function setHealth(id: string, ok: boolean) {
	// untrack: an $effect that calls this must not depend on the value it is about to overwrite,
	// or every poll-driven change would re-run it and restore the old value.
	if (untrack(() => health[id]) !== ok) health[id] = ok;
}
