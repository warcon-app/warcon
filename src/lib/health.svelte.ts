/** Last known reachability per server id, shown as the pulse dot in the switcher and dashboard. */
export const health = $state<Record<string, boolean>>({});

export function setHealth(id: string, ok: boolean) {
	if (health[id] !== ok) health[id] = ok;
}
