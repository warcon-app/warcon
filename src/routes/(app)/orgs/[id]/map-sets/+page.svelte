<script lang="ts">
	// The organisation's map sets: rotations saved under a name, which a server's Map rotation tab
	// loads in place of its rotation. A row per set; a set is made or changed here from its lines
	// as a ServerSettings.ini has them (pasted from a text file or the community rotation
	// builder), or saved from a server's Map rotation tab. Owners only.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import {
		expLabel,
		expSetLabel,
		fmtAgo,
		fmtTime,
		isMod,
		lightingLabel,
		mapName,
		zoneLabel
	} from '$lib/format';
	import Modal from '$lib/components/Modal.svelte';
	import RowMenu from '$lib/components/RowMenu.svelte';
	import {
		cleanMapSetName,
		entriesFromText,
		entriesToText,
		mapCounts,
		MAX_MAP_SET_ENTRIES,
		MAX_MAP_SET_NAME,
		MAX_MAP_SETS
	} from '$lib/map-sets';
	import type { Catalog, MapSelection } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let base = $derived(`/api/orgs/${encodeURIComponent(data.org.id)}/map-sets`);
	/** No server here to ask: the labels fall back to the ids' own words. */
	const CATALOG: Catalog = { maps: [], lightings: [], experiences: [] };
	type View = (typeof data.mapSets)[number];

	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const mapsOf = (entries: MapSelection[]) =>
		mapCounts(entries)
			.map((m) => `${mapName(m.map)} ${m.count}`)
			.join(' · ');
	/** Each modifier the set uses, and on how many of its entries. */
	function modsOf(entries: MapSelection[]): string {
		const counts = new Map<string, { id: string; n: number }>();
		for (const e of entries)
			for (const id of e.experiences.filter(isMod)) {
				const hit = counts.get(id.toLowerCase());
				if (hit) hit.n++;
				else counts.set(id.toLowerCase(), { id, n: 1 });
			}
		return [...counts.values()]
			.map(
				({ id, n }) =>
					`${expLabel(CATALOG, id)} on ${n === entries.length ? 'every entry' : `${n} of ${entries.length}`}`
			)
			.join(' · ');
	}

	let busy = $state(false);

	/** The set being made (`id` null) or changed, as typed. */
	let editing = $state<{ id: string | null; name: string; text: string } | null>(null);
	let read = $derived(editing ? entriesFromText(editing.text) : { entries: [], unread: [] });
	let problem = $derived.by(() => {
		if (!editing) return '';
		if (read.unread.length)
			return `Fix or take out the ${plural(read.unread.length, 'line', 'lines')} not read.`;
		if (!read.entries.length) return 'Paste at least one rotation entry.';
		if (read.entries.length > MAX_MAP_SET_ENTRIES)
			return `A map set holds at most ${MAX_MAP_SET_ENTRIES} rotation entries.`;
		return '';
	});

	/** the saved name of the set being changed, for the dialog's title */
	let editingName = $derived(
		editing?.id ? (data.mapSets.find((s) => s.id === editing?.id)?.name ?? 'map set') : ''
	);

	const startNew = () => (editing = { id: null, name: '', text: '' });
	const startEdit = (s: View) =>
		(editing = { id: s.id, name: s.name, text: entriesToText(s.entries) });

	async function save() {
		const e = editing;
		if (!e || busy || problem) return;
		const name = cleanMapSetName(e.name);
		if (!name) {
			toast('Give the map set a name.', 'err');
			return;
		}
		const was = e.id ? data.mapSets.find((s) => s.id === e.id) : null;
		const body: Record<string, unknown> = {};
		if (!was || was.name !== name) body.name = name;
		if (!was || JSON.stringify(was.entries) !== JSON.stringify(read.entries))
			body.entries = read.entries;
		if (!Object.keys(body).length) {
			editing = null;
			return;
		}
		busy = true;
		try {
			if (e.id) await api('PATCH', `${base}/${encodeURIComponent(e.id)}`, body);
			else await api('POST', base, body);
			toast(
				`${name} saved: ${plural(read.entries.length, 'rotation entry', 'rotation entries')}.`,
				'ok'
			);
			editing = null;
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function remove(s: View) {
		if (
			!(await confirmDialog(
				`Delete the map set ${s.name}? Servers it was loaded on keep their rotation.`,
				{ okLabel: 'Delete', danger: true }
			))
		)
			return;
		busy = true;
		try {
			await api('DELETE', `${base}/${encodeURIComponent(s.id)}`);
			toast(`${s.name} deleted.`, 'ok');
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function copyLines(s: View) {
		try {
			await navigator.clipboard.writeText(entriesToText(s.entries));
			toast(`${s.name}'s lines copied.`, 'ok');
		} catch {
			toast('Could not copy; open Edit and copy the lines by hand.', 'err');
		}
	}
</script>

<div class="panel">
	<span class="label-sm">Map sets</span>
	<p class="note mt-0 mb-4 max-w-[900px]">
		Rotations saved under a name for {data.org.name}'s servers, such as an infantry set and a
		standard one. On a server's Map rotation tab, anyone with Config &amp; settings there loads one
		in place of the rotation and applies it, and switches back by loading the other. A set is its
		entries only: whether the rotation is on, and Ordered or Random, stay as each server has them.
		Save a server's rotation as a set from its Map rotation tab, or paste one in here.
	</p>

	<div class="table-wrap">
		<table>
			<thead
				><tr
					><th>Name</th><th class="num hidden sm:table-cell">Entries</th><th
						class="hidden sm:table-cell">Maps</th
					><th class="hidden md:table-cell">Last saved</th><th></th></tr
				></thead
			>
			<tbody>
				{#each data.mapSets as s (s.id)}
					{@const mods = modsOf(s.entries)}
					<tr>
						<td>
							<!-- A phone has room for the name and the menu: the rest goes under the name, which
							     wraps (a phone's table takes its columns' natural width). -->
							<span class="block max-w-48 font-medium sm:max-w-none">{s.name}</span>
							<span class="block max-w-48 text-[12px] text-mist-400 sm:hidden"
								>{[plural(s.entries.length, 'entry', 'entries'), mapsOf(s.entries), mods]
									.filter(Boolean)
									.join(' · ')}</span
							>
						</td>
						<td class="num hidden sm:table-cell">{s.entries.length}</td>
						<td class="hidden sm:table-cell">
							{mapsOf(s.entries)}
							{#if mods}<span class="block text-[12px] text-mist-400">{mods}</span>{/if}
						</td>
						<td class="hidden whitespace-nowrap text-mist-400 md:table-cell">
							<span title={fmtTime(s.savedAt)}>{fmtAgo(s.savedAt)}</span>
							{#if s.savedBy}by {s.savedBy}{/if}
						</td>
						<td class="w-10">
							<RowMenu label="Actions for {s.name}">
								<button type="button" class="menu-item" role="menuitem" onclick={() => startEdit(s)}
									>Edit</button
								>
								<button type="button" class="menu-item" role="menuitem" onclick={() => copyLines(s)}
									>Copy lines</button
								>
								<hr class="my-1 border-black" />
								<button
									type="button"
									class="menu-item text-danger!"
									role="menuitem"
									disabled={busy}
									onclick={() => remove(s)}>Delete</button
								>
							</RowMenu>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="5" class="py-5 text-center text-mist-600"
							>No map sets yet. Paste the rotation you keep in a text file, or save one from a
							server's Map rotation tab.</td
						>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<div class="mt-3 flex flex-wrap items-center gap-3">
		<button
			class="btn btn-primary"
			disabled={busy || data.mapSets.length >= MAX_MAP_SETS}
			onclick={startNew}>New map set</button
		>
		<span class="text-[12.5px] text-mist-400">{data.mapSets.length} of {MAX_MAP_SETS}</span>
	</div>
</div>

{#if editing}
	<Modal
		title={editing.id ? `Edit ${editingName}` : 'New map set'}
		wide
		onclose={() => (editing = null)}
	>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					bind:value={editing.name}
					maxlength={MAX_MAP_SET_NAME}
					placeholder="Infantry"
					required
				/></label
			>
			<label class="block"
				><span class="field-label">Rotation entries</span><textarea
					class="block min-h-[180px] input resize-y font-mono text-[12px] leading-relaxed"
					rows="9"
					wrap="off"
					spellcheck="false"
					autocomplete="off"
					placeholder={'.RotationEntries=(Map="Kavkazi",Experiences="Bakurani_KOTH_02+KOTH_InfantryOnly",Lighting="DayClear")'}
					bind:value={editing.text}></textarea></label
			>
			<p class="note mt-0">
				One entry a line, as the rotation section of ServerSettings.ini has them. Paste the lines
				from a text file or the community rotation builder; headings, comments and the section's
				other keys are passed over, and the lines are read as the server reads its file, so the set
				plays what they would.
			</p>
			{#if read.unread.length}
				<ul class="space-y-0.5 text-[12.5px] text-danger">
					{#each read.unread.slice(0, 8) as u (u.line)}<li>Line {u.line}: {u.why}.</li>{/each}
					{#if read.unread.length > 8}<li>and {read.unread.length - 8} more.</li>{/if}
				</ul>
			{/if}
			{#if read.entries.length}
				<div class="max-h-[34vh] table-wrap overflow-y-auto">
					<table>
						<thead
							><tr
								><th class="num">#</th><th>Map</th><th>Game mode &amp; mods</th><th
									>Time of day &amp; weather</th
								><th>Control zone</th></tr
							></thead
						>
						<tbody>
							{#each read.entries as e, i (i)}
								<tr>
									<td class="num">{i + 1}</td>
									<td>{mapName(e.map)}</td>
									<td>{expSetLabel(CATALOG, e.experiences)}</td>
									<td>{lightingLabel(CATALOG, e.lighting)}</td>
									<td>{zoneLabel(e.zoneAlternator)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			<div class="flex flex-wrap items-center justify-end gap-2 pt-2">
				<span class="mr-auto text-[12.5px] {problem ? 'text-danger' : 'text-mist-400'}"
					>{problem || plural(read.entries.length, 'rotation entry', 'rotation entries')}</span
				>
				<button type="button" class="btn" data-close onclick={() => (editing = null)}>Cancel</button
				>
				<button type="submit" class="btn btn-primary" disabled={busy || !!problem}>Save</button>
			</div>
		</form>
	</Modal>
{/if}
