<script lang="ts">
	// A reserved-slot group made, renamed, or given to other servers: its name, and every server of
	// the organisation (now and later) or the ones chosen.
	import { untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { describeSync } from '$lib/lists';
	import Modal from '$lib/components/Modal.svelte';
	import type { ListSyncSummary, SlotGroupView } from '$lib/types';

	let {
		org,
		servers,
		group = null,
		mode,
		onclose
	}: {
		org: { id: string; name: string };
		/** every server of the organisation */
		servers: { id: string; name: string }[];
		group?: SlotGroupView | null;
		mode: 'create' | 'rename' | 'servers';
		onclose: () => void;
	} = $props();

	let name = $state(untrack(() => group?.name ?? ''));
	let every = $state(untrack(() => group?.everyServer ?? true));
	let chosen = $state<string[]>(untrack(() => group?.servers.map((s) => s.id) ?? []));
	let busy = $state(false);

	let base = $derived(`/api/orgs/${encodeURIComponent(org.id)}/slot-groups`);
	let title = $derived(
		mode === 'create' ? 'New group' : mode === 'rename' ? `Rename ${group?.name}` : 'Servers'
	);

	async function save() {
		if (mode !== 'rename' && !every && !chosen.length) {
			toast('Choose at least one server, or every server.', 'err');
			return;
		}
		busy = true;
		const target = every ? 'every' : chosen;
		try {
			if (mode === 'create') {
				const res = await api<{ group: SlotGroupView }>('POST', base, {
					name: name.trim(),
					servers: target
				});
				toast(`${res.group.name} made. Add its players, then switch it on.`, 'ok', 8000);
				onclose();
				await goto(
					`/orgs/${encodeURIComponent(org.id)}/reserved/${encodeURIComponent(res.group.id)}`
				);
				return;
			}
			const res = await api<{ group: SlotGroupView; sync: ListSyncSummary }>(
				'PATCH',
				`${base}/${encodeURIComponent(group!.id)}`,
				mode === 'rename' ? { name: name.trim() } : { servers: target }
			);
			toast(
				res.sync.servers.length
					? describeSync(res.sync, `${res.group.name} changed.`)
					: `${res.group.name} changed.`,
				'ok',
				8000
			);
			await invalidateAll();
			onclose();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<Modal {title} {onclose}>
	<form
		class="space-y-3"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		{#if mode !== 'servers'}
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					maxlength="40"
					placeholder="e.g. Clan event, Streamers"
					required
					bind:value={name}
				/></label
			>
		{/if}
		{#if mode !== 'rename'}
			<fieldset>
				<legend class="field-label">Servers</legend>
				<label class="flex items-start gap-2.5 py-1.5">
					<input type="radio" class="mt-1" value={true} bind:group={every} />
					<span
						><b>Every server</b><span class="block text-[12.5px] text-mist-400"
							>All of {org.name}'s servers, and any added later.</span
						></span
					>
				</label>
				<label class="flex items-start gap-2.5 py-1.5">
					<input type="radio" class="mt-1" value={false} bind:group={every} />
					<b>These servers</b>
				</label>
				<div class="flex flex-col gap-1.5 py-1 pl-6">
					{#each servers as s (s.id)}
						<label class="flex items-center gap-2 text-[13.5px] {every ? 'text-mist-600' : ''}"
							><input
								type="checkbox"
								value={s.id}
								bind:group={chosen}
								disabled={every}
							/>{s.name}</label
						>
					{:else}
						<span class="text-[12.5px] text-mist-400">{org.name} has no servers yet.</span>
					{/each}
				</div>
			</fieldset>
		{/if}
		{#if mode === 'create'}
			<p class="note">
				A new group starts off: add its players, then switch it on, now or for a time ahead.
			</p>
		{:else if mode === 'servers' && group?.on}
			<p class="note">
				The group is on: servers taken out lose its slots (live servers keep them until their next
				restart), servers added get them at once.
			</p>
		{/if}
		<div class="flex justify-end gap-2 pt-2">
			<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy}
				>{mode === 'create' ? 'Make group' : 'Save'}</button
			>
		</div>
	</form>
</Modal>
