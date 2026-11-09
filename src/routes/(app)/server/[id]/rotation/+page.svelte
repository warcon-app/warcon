<script lang="ts">
	import { api, rconGet, rconPost, errorMessage } from '$lib/api';
	import { expLabel, expSetLabel, isMod, lightingLabel, mapLabel, zoneLabel } from '$lib/format';
	import { can } from '$lib/capabilities';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import {
		mapsInOrder,
		rotationFromText,
		rotationIntoText,
		setModifierOnAll,
		shuffleFor,
		type RotationDoc
	} from '$lib/rotation-doc';
	import {
		cleanMapSetName,
		mapSetNamed,
		mapSetOf,
		MAX_MAP_SET_NAME,
		MAX_MAP_SETS,
		type MapSet
	} from '$lib/map-sets';
	import Badge from '$lib/components/Badge.svelte';
	import MapPicker from '$lib/components/MapPicker.svelte';
	import MapArt from '$lib/components/MapArt.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type {
		CatalogItem,
		ConfigDoc,
		ConfigResult,
		MapSelection,
		Rotation,
		RotationEntry
	} from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let rotationEdit = $derived(can(data.server.caps, 'rotation.edit'));
	let matchControl = $derived(can(data.server.caps, 'match.control'));
	let rotationSave = $derived(can(data.server.caps, 'rotation.save'));
	let configApply = $derived(can(data.server.caps, 'config.apply'));
	let automation = $derived(can(data.server.caps, 'automation.manage'));
	let configHref = $derived(`/server/${encodeURIComponent(id)}/config`);
	let automationHref = $derived(`/server/${encodeURIComponent(id)}/automation`);

	// Live build CL-499480 serves none of the rotation edit routes. On such a build this tab edits
	// the rotation section of the config document instead: the same table and buttons, staged
	// locally and written to the server in one apply. The server rebuilds its rotation at once and
	// uses the new order from the next map change. The document is for those who may apply it;
	// everyone else reads the live rotation, which such a build cannot edit.
	let viaDoc = $derived(!data.features.rotationEdit && configApply);
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
	let canApply = $derived(configApply && !!doc?.writable);
	let canEdit = $derived(viaDoc ? canApply : rotationEdit && data.features.rotationEdit);
	let canToggle = $derived(viaDoc ? canApply : rotationSave && data.features.liveSettings);

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
		if (viaDoc) {
			void loadDoc();
			void loadMapSets();
		}
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
		void act('rotationSettings', { rotationEnabled: on }, { after: refresh });
	}
	function setMode(mode: string) {
		if (viaDoc) {
			staged.mode = mode === 'random' ? 'random' : 'ordered';
			return;
		}
		void act('rotationSettings', { rotationMode: mode }, { after: refresh });
	}
	// A modifier (Infantry Only, Hardcore) added to or taken off every staged entry at once. It is
	// added only to entries whose map offers it, as the game lists them per map.
	let modifiers = $derived(data.catalog.experiences.filter((x) => isMod(x.id)));
	let modPick = $state('');
	let modOnAll = $derived(
		modifiers.some((m) => m.id === modPick) ? modPick : (modifiers[0]?.id ?? '')
	);
	async function setModOnAll(on: boolean) {
		const mod = modOnAll;
		if (!mod) return;
		const offered = new Map<string, boolean>();
		if (on) {
			busy = true;
			try {
				const maps = [...new Set(staged.entries.map((e) => e.map))];
				const lists = await Promise.all(
					maps.map((m) => rconGet<{ experiences: CatalogItem[] }>(id, 'experiences', { map: m }))
				);
				maps.forEach((m, i) =>
					offered.set(
						m,
						lists[i].experiences.some((x) => x.id.toLowerCase() === mod.toLowerCase())
					)
				);
			} catch (err) {
				toast(errorMessage(err), 'err');
				return;
			} finally {
				busy = false;
			}
		}
		const out = setModifierOnAll(staged.entries, mod, on, (m) => !!offered.get(m));
		staged.entries = out.entries;
		const label = expLabel(data.catalog, mod);
		const n = (k: number) => `${k} ${k === 1 ? 'entry' : 'entries'}`;
		if (!out.changed && !out.skipped) {
			toast(on ? `Every entry has ${label} already.` : `No entry has ${label}.`);
			return;
		}
		let msg = on ? `${label} added to ${n(out.changed)}.` : `${label} taken off ${n(out.changed)}.`;
		const one = out.skipped === 1;
		if (out.skipped)
			msg += on
				? ` Not added to ${n(out.skipped)}: ${one ? 'its map does' : 'their maps do'} not offer it.`
				: ` Left on ${n(out.skipped)}: nothing else is set on ${one ? 'it' : 'them'}.`;
		toast(msg, out.changed ? 'ok' : 'err');
	}
	// The staged entries in a new order: the maps in turn, in the order the rotation first has them,
	// each map's control zones in turn, starting with the map after the one on and the entry on last
	// (see shuffleFor). Played in order, so the mode goes to Ordered.
	function shuffle() {
		const on = rotation?.entries[rotation.nowIndex] ?? null;
		staged.entries = shuffleFor(staged.entries, mapsInOrder(staged.entries), on);
		selected = -1;
		const twice = staged.entries.filter(
			(e, i) => i > 0 && e.map.toLowerCase() === staged.entries[i - 1].map.toLowerCase()
		).length;
		const was = staged.mode;
		staged.mode = 'ordered';
		toast(
			`Shuffled ${staged.entries.length} entries: ${
				twice
					? 'one map has over half of them, so it still comes twice in a row in places'
					: 'no map plays twice in a row'
			}.${was === 'random' ? ' Set to Ordered, so the server plays them in this order.' : ''}`,
			twice ? '' : 'ok'
		);
	}
	function discard() {
		staged = clone(base);
		selected = -1;
	}

	// ---- map sets ----
	// The organisation's saved rotations (its Map sets tab). Loading one puts its entries in the
	// staged rotation, to apply like any other edit; the org's owners keep the staged rotation as a
	// set, a new one or in place of the one of that name.
	let mapSets = $state<MapSet[] | null>(null);
	let manager = $derived(data.server.manager);
	let orgSetsPath = $derived(`/api/orgs/${encodeURIComponent(data.server.orgId)}/map-sets`);
	let mapSetsHref = $derived(`/orgs/${encodeURIComponent(data.server.orgId)}/map-sets`);
	async function loadMapSets() {
		try {
			mapSets = (
				await api<{ mapSets: MapSet[] }>('GET', `/api/servers/${encodeURIComponent(id)}/map-sets`)
			).mapSets;
		} catch {
			mapSets = null;
		}
	}
	/** the set the staged rotation is, if any: in the set's order, or in another */
	let stagedSet = $derived(mapSets ? mapSetOf(mapSets, staged.entries) : null);
	let setPick = $state('');
	let pickedSet = $derived(
		mapSets?.find((s) => s.id === setPick) ?? stagedSet?.set ?? mapSets?.[0] ?? null
	);
	async function loadSet() {
		const set = pickedSet;
		if (!set) return;
		if (stagedSet?.set.id === set.id && !stagedSet.reordered) {
			toast(`The staged rotation is ${set.name} already.`);
			return;
		}
		// Only the entries are replaced, and edits to them kept in a set are not lost.
		const edited = JSON.stringify(staged.entries) !== JSON.stringify(base.entries);
		if (
			edited &&
			!(stagedSet && !stagedSet.reordered) &&
			!(await confirmDialog(
				`Load ${set.name} in place of the staged entries? Your unapplied changes to them are dropped.`,
				{ okLabel: 'Load' }
			))
		)
			return;
		staged.entries = set.entries.map((e) => ({ ...e, experiences: [...e.experiences] }));
		selected = -1;
		const n = set.entries.length;
		toast(
			`${set.name} loaded: ${n} ${n === 1 ? 'entry' : 'entries'} staged. Nothing is sent until you press Apply to server.`,
			'ok'
		);
	}

	let savingAs = $state<{ name: string } | null>(null);
	/** the set Save as replaces: the one with the name typed */
	let replacing = $derived(savingAs && mapSets ? mapSetNamed(mapSets, savingAs.name) : undefined);
	let setsFull = $derived((mapSets?.length ?? 0) >= MAX_MAP_SETS);
	async function saveAs() {
		if (!savingAs || !mapSets || busy) return;
		const name = cleanMapSetName(savingAs.name);
		if (!name) {
			toast('Give the map set a name.', 'err');
			return;
		}
		const over = mapSetNamed(mapSets, name);
		const n = staged.entries.length;
		busy = true;
		try {
			if (over)
				await api('PATCH', `${orgSetsPath}/${encodeURIComponent(over.id)}`, {
					entries: staged.entries
				});
			else await api('POST', orgSetsPath, { name, entries: staged.entries });
			toast(
				over
					? `${over.name} saved: it now holds these ${n} ${n === 1 ? 'entry' : 'entries'}.`
					: `Saved as the map set ${name}.`,
				'ok'
			);
			savingAs = null;
			setPick = '';
			await loadMapSets();
		} catch (err) {
			toast(errorMessage(err), 'err');
			// Another owner may have saved or deleted a set since the list was read: with it read
			// again, the next press replaces the set of that name, or makes the one that went.
			await loadMapSets();
		} finally {
			busy = false;
		}
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
		{#if viaDoc && mapSets && (mapSets.length || manager)}
			<div class="field-group">
				<span class="field-label">Map set</span>
				<div class="join join-wrap w-full">
					<select
						class="input sm:w-48"
						aria-label="Map set"
						value={pickedSet?.id ?? ''}
						disabled={!mapSets.length || busy}
						onchange={(e) => (setPick = e.currentTarget.value)}
					>
						{#each mapSets as s (s.id)}
							<option value={s.id}>{s.name} ({s.entries.length})</option>
						{:else}
							<option value="">None saved yet</option>
						{/each}
					</select>
					<button class="btn" disabled={!canEdit || busy || !pickedSet} onclick={loadSet}
						>Load</button
					>
					{#if manager}
						<button
							class="btn"
							disabled={busy || !rows.length}
							onclick={() => (savingAs = { name: stagedSet?.set.name ?? '' })}>Save as…</button
						>
					{/if}
				</div>
			</div>
		{/if}
		<div class="field-group">
			<span class="field-label">Selected entry</span>
			<div class="join join-stack w-full">
				<button
					class="btn"
					disabled={!canEdit || busy}
					onclick={() => withSel((i) => move(i, 'up'))}>Move up</button
				>
				<button
					class="btn"
					disabled={!canEdit || busy}
					onclick={() => withSel((i) => move(i, 'down'))}>Move down</button
				>
				{#if !viaDoc}
					<button
						class="btn"
						disabled={!matchControl || !data.features.rotationEdit}
						title={data.features.rotationEdit
							? ''
							: 'This server build serves no rotation edit routes, so a next map cannot be queued.'}
						onclick={() =>
							withSel((i) => act('setNextMap', entryToSelection(rows[i]), { after: refresh }))}
						>Play next</button
					>
				{/if}
				<button class="btn btn-danger" disabled={!canEdit || busy} onclick={() => withSel(remove)}
					>Remove</button
				>
			</div>
		</div>
		{#if viaDoc && modifiers.length}
			<div class="field-group">
				<span class="field-label">Every entry</span>
				<div class="join join-wrap w-full">
					<select
						class="input sm:w-40"
						value={modOnAll}
						disabled={!canEdit || busy}
						onchange={(e) => (modPick = e.currentTarget.value)}
					>
						{#each modifiers as m (m.id)}<option value={m.id}>{expLabel(data.catalog, m.id)}</option
							>{/each}
					</select>
					<button
						class="btn"
						disabled={!canEdit || busy || !rows.length}
						onclick={() => setModOnAll(true)}>Add</button
					>
					<button
						class="btn"
						disabled={!canEdit || busy || !rows.length}
						onclick={() => setModOnAll(false)}>Remove</button
					>
				</div>
			</div>
		{/if}
		{#if viaDoc}
			<div class="field-group">
				<span class="field-label">Order</span>
				<div class="join w-full">
					<button
						class="btn w-full"
						disabled={!canEdit || busy || rows.length < 2}
						onclick={shuffle}>Shuffle</button
					>
				</div>
			</div>
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
				disabled={!rotationSave || !data.features.rotationSave}
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
							<span class="inline-flex items-center gap-2.5">
								<MapArt
									map={e.map}
									lighting={e.lighting}
									variant="720"
									alt=""
									class="w-14 shrink-0"
								/>
								{mapLabel(data.catalog, e.map)}
							</span>
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
			{#if stagedSet}{dirty ? 'The staged entries are' : 'It is'} the map set {stagedSet.set
					.name}{stagedSet.reordered ? ', in another order' : ''}.{/if}
		{:else}
			Edits apply to the running server's rotation immediately. Save rotation writes them to the
			config so a restart keeps them (needs the server launched with -StandaloneConfig).
		{/if}
	</p>
	{#if viaDoc && canApply}
		<p class="note">
			Shuffle deals the maps out in turn, so the same map never plays twice in a row.
			{#if automation}For a new order every day, add a
				<a class="link" href={automationHref}>Rotation shuffle</a> rule on the Automation tab.{/if}
			{#if mapSets && (mapSets.length || manager)}Map set puts one of {data.server.orgName}'s saved
				rotations in place of this one, to apply like any other edit{#if manager}; Save as… keeps
					this one as a set, and the organisation's <a class="link" href={mapSetsHref}>Map sets</a> tab
					lists them{/if}.{/if}
		</p>
	{/if}
</div>

<div class="mt-4 panel">
	<span class="label-sm">Add rotation entry</span>
	<MapPicker bind:this={picker} serverId={id} catalog={data.catalog} disabled={!canEdit} />
	<div class="mt-4">
		<button class="btn btn-primary" disabled={!canEdit || busy} onclick={add}
			>Add to rotation</button
		>
	</div>
</div>

{#if savingAs}
	<Modal title="Save as map set" onclose={() => (savingAs = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void saveAs();
			}}
		>
			<p class="text-[13.5px] leading-relaxed">
				Keeps the {staged.entries.length}
				{staged.entries.length === 1 ? 'entry' : 'entries'} in the table{dirty
					? ', unapplied edits included,'
					: ''} as a rotation any of {data.server.orgName}'s servers can load.
			</p>
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					list="map-set-names"
					bind:value={savingAs.name}
					maxlength={MAX_MAP_SET_NAME}
					placeholder="Infantry"
					required
				/></label
			>
			<datalist id="map-set-names">
				{#each mapSets ?? [] as s (s.id)}<option value={s.name}></option>{/each}
			</datalist>
			<p class="note mt-0 {!replacing && setsFull ? 'text-danger' : ''}">
				{#if replacing}Replaces the entries of the map set {replacing.name}, which holds {replacing
						.entries.length} now.{:else if setsFull}{data.server.orgName} keeps {MAX_MAP_SETS} map sets,
					the most it can: name one of them to replace it.{:else}A new map set. Name one that exists
					to replace its entries.{/if}
			</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (savingAs = null)}
					>Cancel</button
				>
				<button type="submit" class="btn btn-primary" disabled={busy || (!replacing && setsFull)}
					>{replacing ? 'Replace' : 'Save'}</button
				>
			</div>
		</form>
	</Modal>
{/if}
