<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import RoleToggle from '$lib/components/RoleToggle.svelte';
	import type { OrgMemberView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let orgPath = $derived(`/api/orgs/${encodeURIComponent(data.org.id)}`);

	type Grid = Record<string, Record<string, string>>;
	/** what the server holds: member -> server -> role ('' for none) */
	let saved = $derived.by<Grid>(() => {
		const g: Grid = {};
		for (const m of data.members) {
			g[m.userId] = {};
			for (const s of data.orgServers)
				g[m.userId][s.id] = m.grants.find((x) => x.serverId === s.id)?.role ?? '';
		}
		return g;
	});
	/** what is being edited; rebuilt from the saved state whenever that changes */
	let grid = $state<Grid>({});
	$effect(() => {
		grid = structuredClone($state.snapshot(saved));
	});

	// Owners (and the site owner) are admin everywhere: no cells to edit.
	const fixed = (m: OrgMemberView) => m.role === 'owner' || m.siteOwner;
	const editable = $derived(data.members.filter((m) => !fixed(m)));

	let q = $state('');
	let shown = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		if (!needle) return data.members;
		return data.members.filter((m) => `${m.name} ${m.username}`.toLowerCase().includes(needle));
	});
	let shownEditable = $derived(shown.filter((m) => !fixed(m)));

	const rowOf = (userId: string) => grid[userId] ?? {};
	const changed = (userId: string) =>
		data.orgServers.some((s) => (rowOf(userId)[s.id] ?? '') !== (saved[userId]?.[s.id] ?? ''));
	let dirty = $derived(editable.filter((m) => changed(m.userId)));

	/** the role shared by every shown member on this server, or null when mixed */
	const columnCommon = (serverId: string): string | null => {
		if (!shownEditable.length) return null;
		const first = rowOf(shownEditable[0].userId)[serverId] ?? '';
		return shownEditable.every((m) => (rowOf(m.userId)[serverId] ?? '') === first) ? first : null;
	};
	const rowCommon = (userId: string): string | null => {
		if (!data.orgServers.length) return null;
		const first = rowOf(userId)[data.orgServers[0].id] ?? '';
		return data.orgServers.every((s) => (rowOf(userId)[s.id] ?? '') === first) ? first : null;
	};
	function setColumn(serverId: string, role: string) {
		for (const m of shownEditable) grid[m.userId][serverId] = role;
	}
	function setRow(userId: string, role: string) {
		for (const s of data.orgServers) grid[userId][s.id] = role;
	}

	let busy = $state(false);
	async function save() {
		busy = true;
		const todo = dirty;
		let done = 0;
		try {
			for (const m of todo) {
				const grants = data.orgServers
					.filter((s) => grid[m.userId][s.id])
					.map((s) => ({ serverId: s.id, role: grid[m.userId][s.id] }));
				await api('PUT', `${orgPath}/members/${m.userId}/grants`, { grants });
				done++;
			}
			toast(`Access updated for ${done} member${done === 1 ? '' : 's'}.`, 'ok');
		} catch (err) {
			toast(`${errorMessage(err)}${done ? ` (${done} of ${todo.length} saved)` : ''}`, 'err');
		} finally {
			busy = false;
			await invalidateAll();
		}
	}
	function discard() {
		grid = structuredClone($state.snapshot(saved));
	}
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div class="text-[13.5px] text-mist-400">
		Each cell is one member's role on one server. Owners run every server and are not listed as
		cells.
	</div>
	<div class="ml-auto flex items-center gap-2">
		<span class="hidden text-[12px] text-mist-600 sm:inline"
			>– none · V viewer · O operator · A admin</span
		>
		{#if data.members.length > 8}
			<input
				class="input w-48"
				type="search"
				placeholder="Filter members…"
				bind:value={q}
				aria-label="Filter members"
			/>
		{/if}
	</div>
</div>

{#if !data.orgServers.length}
	<div class="callout">
		This organisation has no servers yet. <a
			href="/servers"
			class="font-semibold text-accent underline">Add one</a
		> and come back to hand out access.
	</div>
{:else if !data.members.length}
	<div class="callout">
		No members yet. Share an invite link from the <a
			href="/orgs/{encodeURIComponent(data.org.id)}"
			class="font-semibold text-accent underline">overview</a
		>.
	</div>
{:else}
	<div class="access-grid table-wrap">
		<table>
			<thead>
				<tr>
					<th class="sticky-col">Member</th>
					{#each data.orgServers as s (s.id)}
						<th class="text-center">
							<div
								class="truncate tracking-normal normal-case"
								title="{s.name} · {s.host}:{s.port}"
							>
								{s.name}
							</div>
							<div class="mt-1.5">
								<RoleToggle
									value={columnCommon(s.id)}
									label="Everyone on {s.name}"
									onchange={(v) => setColumn(s.id, v)}
									disabled={busy || !shownEditable.length}
								/>
							</div>
						</th>
					{/each}
					<th class="text-center">Every server</th>
				</tr>
			</thead>
			<tbody>
				{#each shown as m (m.userId)}
					{@const isFixed = fixed(m)}
					<tr class={changed(m.userId) ? 'changed' : ''}>
						<td class="sticky-col">
							<div class="flex items-center gap-1.5">
								<span class="truncate">{m.name || m.username}</span>
								{#if m.siteOwner}<Badge tone="accent">site owner</Badge
									>{:else if m.role === 'owner'}<Badge tone="accent">owner</Badge>{/if}
								{#if m.disabled}<Badge tone="err">disabled</Badge>{/if}
							</div>
							<div class="font-mono text-[12px] text-mist-600">@{m.username}</div>
						</td>
						{#if isFixed}
							<td colspan={data.orgServers.length + 1} class="text-mist-600">
								admin on every server{m.siteOwner ? ' (site owner)' : ' (org owner)'}
							</td>
						{:else}
							{#each data.orgServers as s (s.id)}
								<td class="text-center">
									{#if grid[m.userId]}
										<RoleToggle
											bind:value={grid[m.userId][s.id]}
											label="{m.username} on {s.name}"
											disabled={busy}
										/>
									{/if}
								</td>
							{/each}
							<td class="text-center">
								<RoleToggle
									value={rowCommon(m.userId)}
									label="{m.username} on every server"
									onchange={(v) => setRow(m.userId, v)}
									disabled={busy}
								/>
							</td>
						{/if}
					</tr>
				{:else}
					<tr
						><td colspan={data.orgServers.length + 2} class="py-6 text-center text-mist-600"
							>No member matches.</td
						></tr
					>
				{/each}
			</tbody>
		</table>
	</div>

	{#if dirty.length}
		<div
			class="sticky bottom-3 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-card border border-accent/50 bg-ink-900 px-4 py-3 shadow-pop"
		>
			<span class="text-[13.5px]"
				><b>{dirty.length}</b> member{dirty.length === 1 ? '' : 's'} with unsaved changes</span
			>
			<span class="ml-auto inline-flex gap-2">
				<button class="btn" onclick={discard} disabled={busy}>Discard</button>
				<button class="btn btn-primary" onclick={save} disabled={busy}>Save access</button>
			</span>
		</div>
	{/if}
{/if}

<style>
	/* First column stays put while the server columns scroll sideways. */
	.access-grid :global(.sticky-col) {
		position: sticky;
		left: 0;
		z-index: 2;
		max-width: 220px;
		background: var(--color-ink-950);
		box-shadow: inset -1px 0 0 rgb(0 0 0);
	}
	.access-grid :global(th.sticky-col) {
		z-index: 3;
		background: var(--color-ink-900);
	}
	.access-grid :global(tbody tr:hover td.sticky-col) {
		background: var(--color-ink-900);
	}
	.access-grid :global(tr.changed td:first-child) {
		box-shadow:
			inset 2px 0 0 var(--color-accent),
			inset -1px 0 0 rgb(0 0 0);
	}
	.access-grid :global(th) {
		vertical-align: bottom;
		max-width: 160px;
	}
</style>
