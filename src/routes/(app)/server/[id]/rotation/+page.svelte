<script lang="ts">
	import { rconGet, rconPost, errorMessage } from '$lib/api';
	import { can, expSetLabel, lightingLabel, mapLabel, zoneLabel } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { rotationFromText, rotationIntoText, type RotationDoc } from '$lib/rotation-doc';
	import Badge from '$lib/components/Badge.svelte';
	import MapPicker from '$lib/components/MapPicker.svelte';
	import type { ConfigDoc, ConfigResult, MapSelection, Rotation, RotationEntry } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let operator = $derived(can(data.server.role, 'operator'));
	let admin = $derived(can(data.server.role, 'admin'));
	let configHref = $derived(`/server/${encodeURIComponent(id)}/config`);

	// Live build CL-499480 serves none of the rotation edit routes. On such a build this tab edits
	// the rotation section of the config document instead: the same table and buttons, staged
	// locally and written to the server in one apply. The server rebuilds its rotation at once and
	// uses the new order from the next map change.
	let viaDoc = $derived(!data.features.rotationEdit);
	let liveToggle = $derived(!viaDoc && data.features.liveSettings);

	let rotation = $state<Rotation | null>(null);
	let selected = $state(-1);
	let picker = $state<MapPicker>();

	// ---- document mode state ----
	let doc = $state<ConfigDoc | null>(null);
	let docError = $state('');
	let base = $state<RotationDoc>({ enabled: true, mode: 'ordered', entries: [] });
	let staged = $state<RotationDoc>({ enabled: true, mode: 'ordered', entries: [] });
	let busy = $state(false);
	const same = (a: RotationDoc, b: RotationDoc) => JSON.stringify(a) === JSON.stringify(b);
	let dirty = $derived(viaDoc && !same(staged, base));
	let canApply = $derived(admin && !!doc?.writable);
	let canEdit = $derived(viaDoc ? canApply : operator);
	let canToggle = $derived(viaDoc ? canApply : admin && data.features.liveSettings);

	const clone = (r: RotationDoc): RotationDoc => JSON.parse(JSON.stringify(r));

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
	async function loadDoc() {
		try {
			doc = await rconGet<ConfigDoc>(id, 'config');
			docError = '';
			base = rotationFromText(doc.text);
			staged = clone(base);
		} catch (err) {
			doc = null;
			docError = errorMessage(err);
		}
	}
	$effect(() => {
		void refresh();
		if (viaDoc) void loadDoc();
	});

	// The rows shown: the live rotation, or the staged document. Now/next badges come from the
	// live rotation and only make sense while the staged list still matches it.
	let rows = $derived.by((): RotationEntry[] => {
		if (!viaDoc) return rotation?.entries ?? [];
		return staged.entries.map((e, i) => ({
			...e,
			denied: false,
			status: !dirty && rotation?.entries[i] ? rotation.entries[i].status : ''
		}));
	});
	let nowIndex = $derived(
		viaDoc ? (dirty ? -1 : (rotation?.nowIndex ?? -1)) : (rotation?.nowIndex ?? -1)
	);
	let nextIndex = $derived(
		viaDoc ? (dirty ? -1 : (rotation?.nextIndex ?? -1)) : (rotation?.nextIndex ?? -1)
	);
	let enabledShown = $derived(viaDoc ? staged.enabled : !!rotation?.enabled);
	let modeShown = $derived(
		viaDoc ? staged.mode : rotation?.mode === 'random' ? 'random' : 'ordered'
	);

	const entryToSelection = (e: RotationEntry): MapSelection => ({
		map: e.map,
		experiences: e.experiences,
		lighting: e.lighting,
		zoneAlternator: e.zoneAlternator
	});
	function withSel(fn: (i: number) => unknown) {
		if (selected < 0 || !rows[selected]) {
			toast('Select a rotation entry first.', 'err');
			return;
		}
		return fn(selected);
	}

	// ---- edits: live routes, or the staged document ----
	function move(i: number, direction: 'up' | 'down') {
		if (viaDoc) {
			const j = direction === 'up' ? i - 1 : i + 1;
			if (j < 0 || j >= staged.entries.length) return;
			const list = staged.entries.slice();
			[list[i], list[j]] = [list[j], list[i]];
			staged.entries = list;
			selected = j;
			return;
		}
		void act(
			'rotationMove',
			{ index: i, direction },
			{
				after: async () => {
					selected = direction === 'up' ? Math.max(0, i - 1) : i + 1;
					await refresh();
				}
			}
		);
	}
	async function remove(i: number) {
		if (viaDoc) {
			staged.entries = staged.entries.filter((_, k) => k !== i);
			selected = -1;
			return;
		}
		await act(
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
		);
	}
	function add() {
		if (!picker) return;
		const sel = picker.selection();
		if (viaDoc) {
			staged.entries = [...staged.entries, sel];
			selected = staged.entries.length - 1;
			return;
		}
		void act('rotationAdd', sel, { after: refresh });
	}
	function setEnabled(on: boolean) {
		if (viaDoc) {
			staged.enabled = on;
			return;
		}
		void act('settings', { rotationEnabled: on }, { after: refresh });
	}
	function setMode(mode: string) {
		if (viaDoc) {
			staged.mode = mode === 'random' ? 'random' : 'ordered';
			return;
		}
		void act('settings', { rotationMode: mode }, { after: refresh });
	}
	function discard() {
		staged = clone(base);
		selected = -1;
	}
	async function applyDoc() {
		if (!doc || !dirty) return;
		busy = true;
		try {
			const text = rotationIntoText(doc.text, staged);
			const r = await rconPost<ConfigResult>(id, 'configApply', { text, revision: doc.revision });
			if (r.conflict) {
				toast(
					`${r.errorMessage || 'The config changed on the server since it was loaded.'} Reloaded; your edits are kept, press Apply again.`,
					'err'
				);
				const keep = clone(staged);
				await loadDoc();
				staged = keep;
				return;
			}
			if (!r.ok) {
				toast(r.errors?.[0]?.message || r.errorMessage || 'Rejected.', 'err');
				return;
			}
			toast(
				`Rotation applied (revision ${r.revision}). The server rebuilt it; the new order is used from the next map change.`,
				'ok'
			);
			await Promise.all([loadDoc(), refresh()]);
			selected = -1;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	// Long rotations scroll inside the table, so keep the row being worked on in view.
	let tableWrap = $state<HTMLDivElement>();
	$effect(() => {
		const row = tableWrap?.querySelector(selected >= 0 ? 'tr.selected' : 'tr.now');
		row?.scrollIntoView({ block: 'nearest' });
	});
</script>

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-3">
		<span class="mr-auto label-sm mb-0">Rotation</span>
		{#if rotation || doc}
			<label class="inline-flex items-center gap-2 text-[13px]">
				<input
					type="checkbox"
					checked={enabledShown}
					disabled={!canToggle}
					onchange={(e) => setEnabled(e.currentTarget.checked)}
				/> Enabled
			</label>
			<select
				class="input w-32"
				value={modeShown}
				disabled={!canToggle}
				onchange={(e) => setMode(e.currentTarget.value)}
			>
				<option value="ordered">Ordered</option>
				<option value="random">Random</option>
			</select>
		{/if}
	</div>
	{#if viaDoc}
		<div class="callout">
			This server build serves no live rotation editing, so edits here are staged and written to the
			<a class="link" href={configHref}>config document</a> in one apply. The server rebuilds its
			rotation at once and uses the new order from the next map change; if it still runs the old
			order after that, a restart makes it re-read the file.
			{#if docError}<br />No config document could be read ({docError}), so nothing can be changed
				from here.{:else if doc && !doc.writable}<br />The config document is read-only on this
				server, so nothing can be changed from here.{/if}
		</div>
	{:else if !liveToggle}
		<div class="callout">
			This server build cannot switch the rotation on or off, or change its mode, live. Set bEnabled
			and RotationMode in the <a class="link" href={configHref}>config document</a> instead.
		</div>
	{/if}
	<div class="mb-3 flex flex-wrap items-end gap-x-4 gap-y-3">
		<div class="field-group">
			<span class="field-label">Selected entry</span>
			<div class="join join-stack w-full">
				<button class="btn" disabled={!canEdit} onclick={() => withSel((i) => move(i, 'up'))}
					>Move up</button
				>
				<button class="btn" disabled={!canEdit} onclick={() => withSel((i) => move(i, 'down'))}
					>Move down</button
				>
				{#if !viaDoc}
					<button
						class="btn"
						disabled={!operator}
						onclick={() =>
							withSel((i) => act('setNextMap', entryToSelection(rows[i]), { after: refresh }))}
						>Play next</button
					>
				{/if}
				<button class="btn btn-danger" disabled={!canEdit} onclick={() => withSel(remove)}
					>Remove</button
				>
			</div>
		</div>
		{#if viaDoc}
			<div class="join join-stack w-full sm:ml-auto sm:w-auto">
				<button class="btn" disabled={!dirty || busy} onclick={discard}>Discard</button>
				<button class="btn btn-primary" disabled={!dirty || !canApply || busy} onclick={applyDoc}
					>Apply to server{#if dirty}
						&nbsp;({staged.entries.length} entries){/if}</button
				>
			</div>
		{:else}
			<button
				class="btn w-full btn-primary sm:ml-auto sm:w-auto"
				disabled={!admin || !data.features.rotationSave}
				onclick={() => act('rotationSave', {})}>Save rotation</button
			>
		{/if}
	</div>
	<div class="max-h-[55vh] table-wrap overflow-y-auto" bind:this={tableWrap}>
		<table>
			<thead
				><tr
					><th class="num">#</th><th>Map</th><th>Game mode &amp; mods</th><th
						>Time of day &amp; weather</th
					><th>Control zone</th></tr
				></thead
			>
			<tbody>
				{#each rows as e, i (i)}
					<tr
						class="clickable {selected === i ? 'selected' : ''} {i === nowIndex ? 'now' : ''}"
						onclick={() => (selected = selected === i ? -1 : i)}
					>
						<td class="num">{i + 1}</td>
						<td>
							{mapLabel(data.catalog, e.map)}
							{#if i === nowIndex}<Badge tone="accent" class="ml-1">now</Badge
								>{:else if i === nextIndex}<Badge tone="info" class="ml-1">next</Badge>{/if}
							{#if e.denied}<Badge tone="err" class="ml-1">denied</Badge>{/if}
						</td>
						<td>{expSetLabel(data.catalog, e.experiences)}</td>
						<td>{lightingLabel(data.catalog, e.lighting)}</td>
						<td>{zoneLabel(e.zoneAlternator)}</td>
					</tr>
				{:else}
					<tr
						><td colspan="5" class="py-6 text-center text-mist-600"
							>{rotation || doc ? 'The rotation is empty.' : 'Loading…'}</td
						></tr
					>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="note">
		{#if viaDoc}
			{#if dirty}Unapplied edits: {staged.entries.length} entries staged against the server's {base
					.entries.length}. Nothing is sent until you press Apply.{:else}Matches the config document
				(revision {doc?.revision || '—'}).{/if}
		{:else}
			Edits apply to the running server's rotation immediately. Save rotation writes them to the
			config so a restart keeps them (needs the server launched with -StandaloneConfig).
		{/if}
	</p>
</div>

<div class="mt-4 panel">
	<span class="label-sm">Add rotation entry</span>
	<MapPicker bind:this={picker} serverId={id} catalog={data.catalog} disabled={!canEdit} />
	<div class="mt-4">
		<button class="btn btn-primary" disabled={!canEdit} onclick={add}>Add to rotation</button>
	</div>
</div>
