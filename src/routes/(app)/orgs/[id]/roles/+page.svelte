<script lang="ts">
	// Roles × capabilities. Each column is one of the org's server roles; each row is one thing a
	// role may do. Built-ins can be edited and reset but not deleted; custom roles can be deleted
	// once nothing points at them. Edits are held locally until Save, like the access matrix.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import CapabilityPicker from '$lib/components/CapabilityPicker.svelte';
	import { CAPABILITY_INFO, capabilitiesByGroup, VIEW, type Capability } from '$lib/capabilities';
	import type { RoleView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let orgPath = $derived(`/api/orgs/${encodeURIComponent(data.org.id)}`);
	const groups = capabilitiesByGroup();

	type Draft = { name: string; caps: Capability[] };
	/** what the server holds, by role id */
	let saved = $derived.by<Record<string, Draft>>(() =>
		Object.fromEntries(data.roles.map((r) => [r.id, { name: r.name, caps: [...r.capabilities] }]))
	);
	/** what is being edited; rebuilt from the saved state whenever that changes */
	let draft = $state<Record<string, Draft>>({});
	$effect(() => {
		draft = structuredClone($state.snapshot(saved));
	});

	const same = (a: Capability[], b: Capability[]) =>
		a.length === b.length && a.every((c) => b.includes(c));
	const changed = (r: RoleView) =>
		!!draft[r.id] &&
		(draft[r.id].name !== saved[r.id].name || !same(draft[r.id].caps, saved[r.id].caps));
	let dirty = $derived(data.roles.filter(changed));

	const has = (r: RoleView, c: Capability) => !!draft[r.id]?.caps.includes(c);
	function toggle(r: RoleView, c: Capability, on: boolean) {
		if (c === VIEW || !draft[r.id]) return;
		const caps = draft[r.id].caps.filter((v) => v !== c);
		draft[r.id].caps = on ? [...caps, c] : caps;
	}
	const usage = (r: RoleView) => {
		const parts = [];
		if (r.inUse.grants) parts.push(`${r.inUse.grants} grant${r.inUse.grants === 1 ? '' : 's'}`);
		if (r.inUse.invites)
			parts.push(`${r.inUse.invites} invite link${r.inUse.invites === 1 ? '' : 's'}`);
		return parts.join(', ') || 'not in use';
	};

	let busy = $state(false);
	async function run(fn: () => Promise<unknown>, done: string) {
		busy = true;
		try {
			await fn();
			if (done) toast(done, 'ok');
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
	async function save() {
		busy = true;
		const todo = dirty;
		let done = 0;
		try {
			for (const r of todo) {
				const d = draft[r.id];
				await api('PATCH', `${orgPath}/roles/${r.id}`, {
					name: d.name.trim(),
					capabilities: d.caps
				});
				done++;
			}
			toast(`Saved ${done} role${done === 1 ? '' : 's'}.`, 'ok');
		} catch (err) {
			toast(`${errorMessage(err)}${done ? ` (${done} of ${todo.length} saved)` : ''}`, 'err');
		} finally {
			busy = false;
			await invalidateAll();
		}
	}
	function discard() {
		draft = structuredClone($state.snapshot(saved));
	}
	async function reset(r: RoleView) {
		if (
			!(await confirmDialog(
				`Reset '${r.name}' to what ${r.builtin} shipped with? Everyone holding it changes at once.`,
				{ okLabel: 'Reset' }
			))
		)
			return;
		await run(() => api('POST', `${orgPath}/roles/${r.id}/reset`), `${r.builtin} reset.`);
	}
	async function remove(r: RoleView) {
		if (!(await confirmDialog(`Delete the '${r.name}' role?`, { okLabel: 'Delete', danger: true })))
			return;
		await run(() => api('DELETE', `${orgPath}/roles/${r.id}`), `'${r.name}' deleted.`);
	}

	let adding = $state<{ name: string; caps: Capability[] } | null>(null);
	function add() {
		const d = adding;
		if (!d) return;
		void run(async () => {
			await api('POST', `${orgPath}/roles`, { name: d.name.trim(), capabilities: d.caps });
			adding = null;
		}, `'${d.name.trim()}' added.`);
	}
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div class="text-[13.5px] text-mist-400">
		What each server role may do. Changing a role changes it for everyone who holds it, on every
		server. Owners of the organisation always hold everything.
	</div>
	<button class="ml-auto btn" onclick={() => (adding = { name: '', caps: [VIEW] })} disabled={busy}
		>New role</button
	>
</div>

<div class="roles-grid table-wrap">
	<table>
		<thead>
			<tr>
				<th class="sticky-col">Capability</th>
				{#each data.roles as r (r.id)}
					<th class="text-center align-top">
						{#if draft[r.id]}
							<input
								class="input-sm input w-32 text-center"
								type="text"
								bind:value={draft[r.id].name}
								maxlength="40"
								aria-label="Role name"
								disabled={busy}
							/>
						{/if}
						<div class="mt-1 text-[11px] font-normal tracking-normal text-mist-600 normal-case">
							{#if r.builtin}<Badge
									tone={r.builtin === 'admin' ? 'accent' : r.builtin === 'operator' ? 'info' : ''}
									>built-in</Badge
								>{/if}
							<div class="mt-0.5">{usage(r)}</div>
						</div>
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each groups as { group, caps } (group.key)}
				<tr class="group-row">
					<td class="sticky-col caps text-mist-400" colspan={data.roles.length + 1}
						>{group.label}</td
					>
				</tr>
				{#each caps as c (c)}
					<tr>
						<td class="sticky-col">
							<div>{CAPABILITY_INFO[c].label}</div>
							<div class="text-[12px] text-mist-600">{CAPABILITY_INFO[c].hint}</div>
						</td>
						{#each data.roles as r (r.id)}
							<td class="text-center {changed(r) ? 'changed' : ''}">
								<input
									type="checkbox"
									checked={c === VIEW || has(r, c)}
									disabled={busy || c === VIEW}
									aria-label="{draft[r.id]?.name ?? r.name}: {CAPABILITY_INFO[c].label}"
									onchange={(e) => toggle(r, c, (e.currentTarget as HTMLInputElement).checked)}
								/>
							</td>
						{/each}
					</tr>
				{/each}
			{/each}
			<tr>
				<td class="sticky-col"></td>
				{#each data.roles as r (r.id)}
					<td class="text-center">
						<span class="inline-flex flex-wrap justify-center gap-1">
							{#if r.builtin}
								<button class="btn btn-sm" onclick={() => reset(r)} disabled={busy}>Reset</button>
							{:else}
								<button
									class="btn btn-sm btn-danger"
									onclick={() => remove(r)}
									disabled={busy || r.inUse.grants > 0 || r.inUse.invites > 0}
									title={r.inUse.grants || r.inUse.invites
										? `Still used by ${usage(r)}`
										: 'Delete this role'}>Delete</button
								>
							{/if}
						</span>
					</td>
				{/each}
			</tr>
		</tbody>
	</table>
</div>

{#if dirty.length}
	<div
		class="sticky bottom-3 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-card border border-accent/50 bg-ink-900 px-4 py-3 shadow-pop"
	>
		<span class="text-[13.5px]"
			><b>{dirty.length}</b> role{dirty.length === 1 ? '' : 's'} with unsaved changes</span
		>
		<span class="ml-auto inline-flex gap-2">
			<button class="btn" onclick={discard} disabled={busy}>Discard</button>
			<button class="btn btn-primary" onclick={save} disabled={busy}>Save roles</button>
		</span>
	</div>
{/if}

{#if adding}
	{@const d = adding}
	<Modal title="New role" onclose={() => (adding = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				add();
			}}
		>
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					bind:value={d.name}
					placeholder="e.g. Trial staff"
					maxlength="40"
					required
				/></label
			>
			<CapabilityPicker bind:value={d.caps} locked={[VIEW]} disabled={busy} />
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (adding = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy || d.name.trim().length < 2}
					>Add role</button
				>
			</div>
		</form>
	</Modal>
{/if}

<style>
	.roles-grid :global(.sticky-col) {
		position: sticky;
		left: 0;
		z-index: 2;
		max-width: 260px;
		background: var(--color-ink-950);
		box-shadow: inset -1px 0 0 rgb(0 0 0);
	}
	.roles-grid :global(th.sticky-col) {
		z-index: 3;
		background: var(--color-ink-900);
	}
	.roles-grid :global(tbody tr:hover td.sticky-col) {
		background: var(--color-ink-900);
	}
	.roles-grid :global(tr.group-row td) {
		padding-top: 10px;
		padding-bottom: 4px;
		font-size: 11px;
	}
	.roles-grid :global(td.changed) {
		box-shadow: inset 0 -2px 0 var(--color-accent);
	}
	.roles-grid :global(th) {
		vertical-align: top;
	}
</style>
