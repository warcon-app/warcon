<script lang="ts">
	// The organisation's ban list: its entries, where each stands on every server, and the add /
	// remove controls.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { describeSync, STATE_TEXT, STATE_TONE } from '$lib/lists';
	import { nextDir, sortRows, type SortDir, type SortValue } from '$lib/sort';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import ImportCandidates from './ImportCandidates.svelte';
	import type { ListEntryView, ListSyncSummary, OrgListsView } from '$lib/types';

	let {
		entries,
		lists,
		org
	}: {
		entries: ListEntryView[];
		lists: OrgListsView;
		org: { id: string; name: string };
	} = $props();

	let path = $derived(`/api/orgs/${encodeURIComponent(org.id)}/lists/ban/entries`);
	let search = $state('');
	let busy = $state(false);
	let banning = $state(false);
	let owner = $derived(lists.role === 'owner');

	/** what each sortable column reads off a row; an unknown field is null, so it sorts last */
	const COLUMNS: Record<string, (e: ListEntryView) => SortValue> = {
		player: (e) => e.name || e.steamId,
		reason: (e) => e.reason || null,
		addedBy: (e) => e.addedByName || null,
		addedAt: (e) => e.addedAt,
		// A ban that never expires has nothing to show here, so it sorts to the end either way.
		expiresAt: (e) => e.expiresAt
	};
	/** text reads best A to Z, the newest ban first, and the soonest expiry first */
	const ASC_FIRST = new Set(['player', 'reason', 'addedBy', 'expiresAt']);
	let sort = $state<{ key: string; dir: SortDir }>({ key: '', dir: 'desc' });
	function sortBy(key: string) {
		const fallback = ASC_FIRST.has(key) ? 'asc' : 'desc';
		sort = { key, dir: nextDir(sort.key, sort.dir, key, fallback) };
	}

	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const found = entries.filter(
			(e) =>
				!q ||
				e.steamId.includes(q) ||
				(e.name || '').toLowerCase().includes(q) ||
				e.reason.toLowerCase().includes(q) ||
				e.addedByName.toLowerCase().includes(q)
		);
		const column = COLUMNS[sort.key];
		return column ? sortRows(found, column, sort.dir) : found;
	});
	let dossierBase = $derived(
		lists.servers.length ? `/server/${encodeURIComponent(lists.servers[0].id)}/players` : null
	);

	async function syncNow() {
		busy = true;
		try {
			const res = await api<{ sync: ListSyncSummary }>(
				'POST',
				`/api/orgs/${encodeURIComponent(org.id)}/lists/sync`
			);
			toast(describeSync(res.sync, 'Sync ran.'), 'ok', 8000);
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function remove(e: ListEntryView) {
		const label = e.name ? `${e.name} (${e.steamId})` : e.steamId;
		if (
			!(await confirmDialog(
				`Unban ${label} across ${org.name}? The panel lifts the ban on every server it applied it to.`,
				{ okLabel: 'Unban', danger: true }
			))
		)
			return;
		busy = true;
		try {
			const res = await api<{ sync: ListSyncSummary }>(
				'DELETE',
				`${path}/${encodeURIComponent(e.steamId)}`
			);
			toast(describeSync(res.sync, `Unbanned ${e.steamId}.`), 'ok', 8000);
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div>
		<h2 class="text-lg font-semibold tracking-tight">Ban list</h2>
		<p class="text-[13px] text-mist-400">
			Bans kept by the organisation and pushed to every one of its servers. Bans added on a server
			directly stay local to it.
		</p>
	</div>
	<span class="ml-auto inline-flex gap-1.5">
		<button class="btn" disabled={busy || !lists.servers.length} onclick={syncNow}>Sync now</button>
		<button class="btn btn-primary" onclick={() => (banning = true)}>Add ban</button>
	</span>
</div>

{#if lists.servers.length}
	<div class="mb-4 flex flex-wrap gap-2">
		{#each lists.servers as s (s.id)}
			<div
				class="rounded-ctl border border-black bg-ink-950 px-3 py-2 text-[12.5px] {s.lastError
					? 'border-l-2 border-l-danger'
					: ''}"
			>
				<div class="font-medium">{s.name}</div>
				<div class="text-mist-400">
					{#if s.syncedAt}synced {fmtTime(s.syncedAt)}{:else}never synced{/if}
				</div>
				{#if s.lastError}<div class="text-danger">{s.lastError}</div>{/if}
			</div>
		{/each}
	</div>
{/if}

<ImportCandidates kind="ban" {org} {owner} />

{#if !lists.servers.length}
	<div class="callout mb-4">
		{org.name} has no servers yet, so there is nothing to push the list to. Entries are kept and applied
		when a server is added.
	</div>
{/if}

<div class="mb-3 flex flex-wrap items-center gap-2">
	<input
		class="input w-full sm:w-80"
		type="search"
		placeholder="Filter by name, SteamID, reason, admin…"
		bind:value={search}
	/>
	<span class="text-[12.5px] text-mist-600"
		>{entries.length} ban{entries.length === 1 ? '' : 's'}</span
	>
</div>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<SortHeader
					label="Player"
					active={sort.key === 'player'}
					dir={sort.dir}
					onsort={() => sortBy('player')}
				/>
				<SortHeader
					label="Reason"
					active={sort.key === 'reason'}
					dir={sort.dir}
					onsort={() => sortBy('reason')}
				/>
				<SortHeader
					label="By"
					active={sort.key === 'addedBy'}
					dir={sort.dir}
					onsort={() => sortBy('addedBy')}
				/>
				<SortHeader
					label="Added"
					active={sort.key === 'addedAt'}
					dir={sort.dir}
					onsort={() => sortBy('addedAt')}
				/>
				<SortHeader
					label="Expires"
					active={sort.key === 'expiresAt'}
					dir={sort.dir}
					onsort={() => sortBy('expiresAt')}
				/>
				<th>Servers</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each rows as e (e.id)}
				<tr class={e.expired ? 'text-mist-400' : ''}>
					<td>
						{#if dossierBase}
							<a href="{dossierBase}/{e.steamId}" class="font-medium text-accent hover:underline"
								>{e.name || e.steamId}</a
							>
						{:else}
							<span class="font-medium">{e.name || e.steamId}</span>
						{/if}
						{#if e.name}<div class="font-mono text-[12px] text-mist-600">{e.steamId}</div>{/if}
					</td>
					<td class="max-w-[280px]">
						{#if e.reason}{e.reason}{:else}<span class="text-mist-600">—</span>{/if}
					</td>
					<td>{e.addedByName || '—'}</td>
					<td class="text-[12.5px] whitespace-nowrap text-mist-400">{fmtTime(e.addedAt)}</td>
					<td class="text-[12.5px] whitespace-nowrap">
						{#if !e.expiresAt}
							<span class="text-mist-600">never</span>
						{:else if e.expired}
							<Badge tone="warn">expired, lifting</Badge>
						{:else}
							{fmtTime(e.expiresAt)}
						{/if}
					</td>
					<td>
						<span class="inline-flex flex-wrap gap-1">
							{#each e.servers as s (s.serverId)}
								<span title="{s.serverName}: {STATE_TEXT[s.state]}{s.error ? ` — ${s.error}` : ''}">
									<Badge tone={STATE_TONE[s.state]}>{s.serverName}</Badge>
								</span>
							{/each}
						</span>
					</td>
					<td class="text-right whitespace-nowrap">
						<button class="btn btn-sm btn-danger" disabled={busy} onclick={() => remove(e)}
							>Unban</button
						>
					</td>
				</tr>
			{:else}
				<tr
					><td colspan="7" class="py-6 text-center text-mist-600"
						>{entries.length ? 'Nothing matches the filter.' : 'No bans yet.'}</td
					></tr
				>
			{/each}
		</tbody>
	</table>
</div>

<p class="note">
	Server badges: <Badge tone="ok">applied</Badge> by the panel, <Badge tone="warn">pending</Badge> the
	next sync, <Badge tone="err">failed</Badge> (hover for why), <Badge>local</Badge> already on that server
	but added outside the panel, so the panel never removes it.
</p>

{#if banning}
	<BanDialog
		orgId={org.id}
		orgName={org.name}
		canOrg
		onclose={() => (banning = false)}
		ondone={() => invalidateAll()}
	/>
{/if}
