<script lang="ts">
	import { rconGet, rconPost, errorMessage } from '$lib/api';
	import { can, expSetLabel, lightingLabel, mapLabel, zoneLabel } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import MapPicker from '$lib/components/MapPicker.svelte';
	import type { Rotation, RotationEntry } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let operator = $derived(can(data.server.role, 'operator'));
	let admin = $derived(can(data.server.role, 'admin'));

	let rotation = $state<Rotation | null>(null);
	let selected = $state(-1);
	let picker = $state<MapPicker>();

	async function act(
		action: string,
		params: object,
		opts: { confirm?: string; danger?: boolean; after?: () => Promise<unknown> } = {}
	) {
		if (
			opts.confirm &&
			!(await confirmDialog(opts.confirm, { okLabel: 'Do it', danger: opts.danger }))
		)
			return null;
		try {
			const result = await rconPost<{ message?: string }>(id, action, params);
			toast(result?.message || `${action} done.`, 'ok');
			if (opts.after) await opts.after();
			return result;
		} catch (err) {
			toast(errorMessage(err), 'err');
			return null;
		}
	}
	async function refresh() {
		try {
			rotation = await rconGet<Rotation>(id, 'rotation');
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	$effect(() => {
		void refresh();
	});

	const entryToSelection = (e: RotationEntry) => ({
		map: e.map,
		experiences: e.experiences,
		lighting: e.lighting,
		zoneAlternator: e.zoneAlternator
	});
	function withSel(fn: (i: number) => unknown) {
		if (selected < 0 || !rotation?.entries[selected]) {
			toast('Select a rotation entry first.', 'err');
			return;
		}
		return fn(selected);
	}
</script>

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-3">
		<span class="mr-auto label-sm mb-0">Rotation</span>
		{#if rotation}
			<label class="inline-flex items-center gap-2 text-[13px]">
				<input
					type="checkbox"
					checked={rotation.enabled}
					disabled={!admin}
					onchange={(e) =>
						act('settings', { rotationEnabled: e.currentTarget.checked }, { after: refresh })}
				/> Enabled
			</label>
			<select
				class="input w-32"
				value={rotation.mode === 'random' ? 'random' : 'ordered'}
				disabled={!admin}
				onchange={(e) =>
					act('settings', { rotationMode: e.currentTarget.value }, { after: refresh })}
			>
				<option value="ordered">Ordered</option>
				<option value="random">Random</option>
			</select>
		{/if}
	</div>
	<div class="table-wrap">
		<table>
			<thead
				><tr
					><th class="num">#</th><th>Map</th><th>Game mode &amp; mods</th><th
						>Time of day &amp; weather</th
					><th>Control zone</th></tr
				></thead
			>
			<tbody>
				{#each rotation?.entries ?? [] as e, i (i)}
					<tr
						class="clickable {selected === i ? 'selected' : ''}"
						onclick={() => (selected = selected === i ? -1 : i)}
					>
						<td class="num">{i + 1}</td>
						<td>
							{mapLabel(data.catalog, e.map)}
							{#if rotation && i === rotation.nowIndex}<Badge tone="accent" class="ml-1">now</Badge
								>{:else if rotation && i === rotation.nextIndex}<Badge tone="info" class="ml-1"
									>next</Badge
								>{/if}
							{#if e.denied}<Badge tone="err" class="ml-1">denied</Badge>{/if}
						</td>
						<td>{expSetLabel(data.catalog, e.experiences)}</td>
						<td>{lightingLabel(data.catalog, e.lighting)}</td>
						<td>{zoneLabel(e.zoneAlternator)}</td>
					</tr>
				{:else}
					<tr
						><td colspan="5" class="py-6 text-center text-mist-600"
							>{rotation ? 'The rotation is empty.' : 'Loading…'}</td
						></tr
					>
				{/each}
			</tbody>
		</table>
	</div>
	<div class="mt-3 flex flex-wrap gap-2">
		<button
			class="btn"
			disabled={!operator}
			onclick={() =>
				withSel((i) =>
					act(
						'rotationMove',
						{ index: i, direction: 'up' },
						{
							after: async () => {
								selected = Math.max(0, i - 1);
								await refresh();
							}
						}
					)
				)}>Move up</button
		>
		<button
			class="btn"
			disabled={!operator}
			onclick={() =>
				withSel((i) =>
					act(
						'rotationMove',
						{ index: i, direction: 'down' },
						{
							after: async () => {
								selected = i + 1;
								await refresh();
							}
						}
					)
				)}>Move down</button
		>
		<button
			class="btn btn-danger"
			disabled={!operator}
			onclick={() =>
				withSel((i) =>
					act(
						'rotationRemove',
						{ index: i },
						{
							confirm: `Remove rotation entry ${i + 1}?`,
							danger: true,
							after: async () => {
								selected = -1;
								await refresh();
							}
						}
					)
				)}>Remove</button
		>
		<button
			class="btn"
			disabled={!operator}
			onclick={() =>
				withSel((i) =>
					act('setNextMap', entryToSelection(rotation!.entries[i]), { after: refresh })
				)}>Play next</button
		>
		<button
			class="ml-auto btn btn-primary"
			disabled={!admin}
			onclick={() => act('rotationSave', {})}>Save rotation</button
		>
	</div>
	<p class="note">
		Edits apply to the running server's rotation immediately. Save rotation writes them to the
		config so a restart keeps them (needs the server launched with -StandaloneConfig).
	</p>
</div>

<div class="mt-4 panel">
	<span class="label-sm">Add rotation entry</span>
	<MapPicker bind:this={picker} serverId={id} catalog={data.catalog} disabled={!operator} />
	<div class="mt-4">
		<button
			class="btn btn-primary"
			disabled={!operator}
			onclick={() => picker && act('rotationAdd', picker.selection(), { after: refresh })}
			>Add to rotation</button
		>
	</div>
</div>
