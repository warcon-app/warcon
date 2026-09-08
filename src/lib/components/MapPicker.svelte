<script lang="ts">
	import { untrack } from 'svelte';
	import { rconGet, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { expLabel, isMod, mapLabel, zoneLabel } from '$lib/format';
	import type { Catalog, CatalogItem, MapSelection } from '$lib/types';

	let {
		serverId,
		catalog,
		disabled = false
	}: { serverId: string; catalog: Catalog; disabled?: boolean } = $props();

	let map = $state('');
	let mode = $state('');
	let lighting = $state('');
	let zone = $state('');
	let mods = $state<string[]>([]);
	let modes = $state<CatalogItem[]>([]);
	let modOptions = $state<CatalogItem[]>([]);
	let zones = $state<{ tag: string; display: string }[]>([]);
	let seq = 0;

	async function loadMap(keep?: Partial<MapSelection>) {
		const my = ++seq;
		const m = map;
		let exps: CatalogItem[] = [];
		let alts: { tag: string; display: string }[] = [];
		try {
			[exps, alts] = await Promise.all([
				rconGet<{ experiences: CatalogItem[] }>(serverId, 'experiences', { map: m }).then(
					(d) => d.experiences
				),
				rconGet<{ alternators: { tag: string; display: string }[] }>(serverId, 'alternators', {
					map: m
				})
					.then((d) => d.alternators)
					.catch(() => [])
			]);
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
		if (my !== seq) return;
		modes = exps.filter((x) => !isMod(x.id));
		modOptions = exps.filter((x) => isMod(x.id));
		zones = alts;
		const wanted = (keep?.experiences || []).find((i) => !isMod(i));
		mode = wanted && modes.some((x) => x.id === wanted) ? wanted : (modes[0]?.id ?? '');
		mods = (keep?.experiences || []).filter((i) => modOptions.some((x) => x.id === i));
		zone =
			keep?.zoneAlternator && zones.some((z) => z.tag === keep.zoneAlternator)
				? keep.zoneAlternator
				: '';
	}

	$effect(() => {
		untrack(() => {
			map = catalog.maps[0]?.id ?? '';
			lighting = catalog.lightings[0]?.id ?? '';
			void loadMap();
		});
	});

	export function selection(): MapSelection {
		return { map, experiences: [mode, ...mods].filter(Boolean), lighting, zoneAlternator: zone };
	}

	export async function setFrom(entry: Partial<MapSelection>) {
		if (entry.map && catalog.maps.some((m) => m.id === entry.map)) map = entry.map;
		if (entry.lighting && catalog.lightings.some((l) => l.id === entry.lighting))
			lighting = entry.lighting;
		await loadMap(entry);
	}
</script>

<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
	<label class="block">
		<span class="label-sm">Map</span>
		<select class="input" bind:value={map} onchange={() => loadMap()} {disabled}>
			{#each catalog.maps as m (m.id)}<option value={m.id}>{mapLabel(catalog, m.id)}</option>{/each}
		</select>
	</label>
	<label class="block">
		<span class="label-sm">Game mode</span>
		<select class="input" bind:value={mode} {disabled}>
			{#each modes as e (e.id)}<option value={e.id}>{e.display}</option>{/each}
		</select>
	</label>
	<label class="block">
		<span class="label-sm">Time of day &amp; weather</span>
		<select class="input" bind:value={lighting} {disabled}>
			{#each catalog.lightings as l (l.id)}<option value={l.id}>{l.display}</option>{/each}
		</select>
	</label>
	<label class="block">
		<span class="label-sm">Control zone</span>
		<select class="input" bind:value={zone} {disabled}>
			<option value="">Default</option>
			{#each zones as z (z.tag)}<option value={z.tag}>{z.display || zoneLabel(z.tag)}</option
				>{/each}
		</select>
	</label>
	<div class="sm:col-span-2 lg:col-span-4">
		<span class="label-sm">Modifications</span>
		<div class="flex flex-wrap gap-x-5 gap-y-2">
			{#each modOptions as e (e.id)}
				<label class="inline-flex items-center gap-2 text-[13px]">
					<input type="checkbox" value={e.id} bind:group={mods} {disabled} />
					{expLabel(catalog, e.id)}
				</label>
			{:else}
				<span class="text-mist-600">None for this map.</span>
			{/each}
		</div>
	</div>
</div>
