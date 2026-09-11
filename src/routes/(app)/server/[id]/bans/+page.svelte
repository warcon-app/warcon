<script lang="ts">
	// This server's ban list and reserved slots as the game server holds them, with what the
	// organisation's lists contribute marked out, and the way into those lists.
	import { invalidateAll } from '$app/navigation';
	import { api, rconGet, rconPost, errorMessage } from '$lib/api';
	import { can, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import { describeSync, STATE_TONE } from '$lib/lists';
	import type { Ban, ListSyncServer, ListSyncSummary, ServerListsState } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let admin = $derived(can(data.server.role, 'admin'));
	let orgPath = $derived(`/orgs/${encodeURIComponent(data.server.orgId)}`);

	let listState = $state<ServerListsState | null>(null);
	$effect(() => {
		listState = data.listState;
	});
	let bans = $state<Ban[]>([]);
	let reserved = $state<string[]>([]);
	let banSearch = $state('');
	let selectedBan = $state<string | null>(null);
	let reservedId = $state('');
	let busy = $state(false);
	let banning = $state(false);

	let banRows = $derived.by(() => {
		const q = banSearch.trim().toLowerCase();
		return bans.filter(
			(b) =>
				!q ||
				b.steamId.includes(q) ||
				(b.bannedBy || '').toLowerCase().includes(q) ||
				(b.reason || '').toLowerCase().includes(q)
		);
	});
	let orgBanCount = $derived(
		data.orgLists?.lists.find((l) => l.kind === 'ban')?.entryCount ?? null
	);
	let orgReserveCount = $derived(
		data.orgLists?.lists.find((l) => l.kind === 'reserve')?.entryCount ?? null
	);
	let managedBans = $derived(Object.values(listState?.bans ?? {}).filter((s) => s.managed).length);
	let managedSlots = $derived(
		Object.values(listState?.reserved ?? {}).filter((s) => s.managed).length
	);
	let pendingCount = $derived(
		[...Object.values(listState?.bans ?? {}), ...Object.values(listState?.reserved ?? {})].filter(
			(s) => s.state === 'pending' || s.state === 'failed'
		).length
	);

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
	async function refreshListState() {
		try {
			listState = await api<ServerListsState>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/lists/state`
			);
		} catch (err) {
			console.warn('list state', err);
		}
	}
	async function refreshReserved() {
		reserved = (await rconGet<{ reserved: string[] }>(id, 'reserved')).reserved;
		void refreshListState();
	}
	async function refreshBans() {
		bans = (await rconGet<{ bans: Ban[] }>(id, 'bans')).bans;
		void refreshListState();
	}
	const refreshAll = () => Promise.all([refreshReserved(), refreshBans(), invalidateAll()]);

	$effect(() => {
		void id;
		Promise.all([refreshReserved(), refreshBans()]).catch((err) => toast(errorMessage(err), 'err'));
	});

	const banSource = (steamId: string) => listState?.bans[steamId] ?? null;
	const slotSource = (steamId: string) => listState?.reserved[steamId] ?? null;

	async function syncNow() {
		busy = true;
		try {
			const res = await api<{ sync: ListSyncServer }>(
				'POST',
				`/api/servers/${encodeURIComponent(id)}/lists/sync`
			);
			toast(describeSync({ servers: [res.sync] }, 'Sync ran.'), 'ok', 8000);
			await refreshAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	/**
	 * Put a local ban on the org list. Owners import it (the panel then manages it here too);
	 * editors add it to the list, and this server's copy stays local.
	 */
	async function promoteSelected() {
		if (!selectedBan || !listState) return;
		const steamId = selectedBan;
		const ban = bans.find((b) => b.steamId === steamId);
		const lists = `/api/orgs/${encodeURIComponent(listState.orgId)}/lists`;
		busy = true;
		try {
			const res = listState.orgOwner
				? await api<{ sync: ListSyncSummary }>('POST', `${lists}/import`, {
						entries: [{ kind: 'ban', steamId, reason: ban?.reason ?? '' }]
					})
				: await api<{ sync: ListSyncSummary }>('POST', `${lists}/ban/entries`, {
						steamId,
						reason: ban?.reason ?? ''
					});
			toast(describeSync(res.sync, `${steamId} is on the organisation's ban list.`), 'ok', 8000);
			await refreshAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
	async function unbanSelected() {
		if (!selectedBan) return;
		const src = banSource(selectedBan);
		const confirm = src?.managed
			? `${selectedBan} is banned by the organisation's ban list, so the panel will ban them again at the next sync. Unban here anyway? To lift it everywhere, remove it from the organisation's ban list instead.`
			: `Unban ${selectedBan}?`;
		await act(
			'unban',
			{ steamId: selectedBan },
			{
				confirm,
				danger: !!src?.managed,
				after: async () => {
					selectedBan = null;
					await refreshBans();
				}
			}
		);
	}
</script>

<div class="mb-4 panel">
	<div class="mb-2 flex flex-wrap items-center gap-2">
		<span class="label-sm mb-0!">Organisation lists · {data.server.orgName}</span>
		<span class="ml-auto inline-flex flex-wrap gap-1.5">
			{#if listState?.canEditOrg}
				<a class="btn btn-sm" href="{orgPath}/bans">Ban list</a>
				<a class="btn btn-sm" href="{orgPath}/reserved">Reserved slots</a>
			{/if}
			{#if admin}
				<button class="btn btn-sm" disabled={busy} onclick={syncNow}>Sync now</button>
			{/if}
		</span>
	</div>
	<div class="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
		{#if data.orgLists}
			<span
				><b>{orgBanCount}</b> org ban{orgBanCount === 1 ? '' : 's'}, <b>{managedBans}</b> applied here</span
			>
			<span
				><b>{orgReserveCount}</b> org reserved slot{orgReserveCount === 1 ? '' : 's'},
				<b>{managedSlots}</b> applied here</span
			>
		{:else}
			<span class="text-mist-400"
				>Managed by the organisation's owners and server admins; entries they push here are marked
				<Badge tone="ok">org</Badge> below.</span
			>
		{/if}
		{#if pendingCount}<Badge tone="warn">{pendingCount} pending or failed</Badge>{/if}
	</div>
	<div class="mt-1 text-[12.5px] text-mist-400">
		{#if listState?.sync?.syncedAt}
			Last synced {fmtTime(
				listState.sync.syncedAt
			)}{#if listState.sync.reservedCap !== null}{' · '}reserved slots {listState.sync.reservedUsed} /
				{listState.sync.reservedCap}{/if}.
		{:else}
			Not synced yet.
		{/if}
		{#if listState?.sync?.lastError}<span class="text-danger">
				{listState.sync.lastError}</span
			>{/if}
	</div>
</div>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
	<div class="panel">
		<span class="label-sm">Reserved slots on this server</span>
		<div class="mb-3 flex flex-wrap gap-1.5">
			{#each reserved as r (r)}
				{@const src = slotSource(r)}
				<button
					type="button"
					class="chip cursor-pointer hover:bg-white/12 {src?.managed ? 'text-accent' : ''}"
					title={src?.managed ? 'From the organisation list' : 'Added on this server'}
					onclick={() => (reservedId = r)}>{r}</button
				>
			{:else}
				<span class="text-mist-600">None.</span>
			{/each}
		</div>
		<div class="join join-wrap w-full">
			<input
				class="input font-mono"
				type="text"
				placeholder="SteamID64…"
				maxlength="17"
				bind:value={reservedId}
			/>
			<button
				class="btn"
				disabled={!admin || !data.features.reservedSlots}
				onclick={() =>
					act(
						'reservedAdd',
						{ steamId: reservedId.trim() },
						{
							after: async () => {
								reservedId = '';
								await refreshReserved();
							}
						}
					)}>Add</button
			>
			<button
				class="btn btn-danger"
				disabled={!admin || !data.features.reservedSlots}
				onclick={() =>
					act(
						'reservedRemove',
						{ steamId: reservedId.trim() },
						{
							after: async () => {
								reservedId = '';
								await refreshReserved();
							}
						}
					)}>Remove</button
			>
		</div>
		<p class="note">
			{#if !data.features.reservedSlots}This server build has no live reserved-slot routes; add
				+DefaultReservedPlayerIds lines to the config document instead.{/if}
			Click a slot to fill the field. Slots added here are written to this server's ServerSettings.ini
			only; <span class="text-accent">highlighted</span> ones come from the organisation list.
		</p>
	</div>
	<div class="panel lg:col-span-2">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<span class="label-sm mb-0!">Bans on this server</span>
			<button
				class="ml-auto btn btn-sm btn-danger"
				disabled={!admin}
				onclick={() => (banning = true)}>Ban a SteamID</button
			>
		</div>
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<div class="join w-full sm:w-auto sm:min-w-[320px]">
				<input
					class="input"
					type="search"
					placeholder="Filter bans by SteamID, admin, reason…"
					bind:value={banSearch}
				/>
				<button class="btn" onclick={refreshBans}>Refresh</button>
			</div>
			<span class="inline-flex gap-1.5 sm:ml-auto">
				{#if selectedBan && listState?.canEditOrg && !banSource(selectedBan)?.managed}
					<button class="btn" disabled={busy} onclick={promoteSelected}
						>{listState.orgOwner ? 'Promote to org list' : 'Add to org list'}</button
					>
				{/if}
				<button class="btn btn-danger" disabled={!admin || !selectedBan} onclick={unbanSelected}
					>Unban selected</button
				>
			</span>
		</div>
		<div class="table-wrap">
			<table>
				<thead
					><tr
						><th>SteamID64</th><th>Source</th><th>Banned at (UTC)</th><th>By</th><th>Reason</th></tr
					></thead
				>
				<tbody>
					{#each banRows as b (b.steamId)}
						{@const src = banSource(b.steamId)}
						<tr
							class="clickable {selectedBan === b.steamId ? 'selected' : ''}"
							onclick={() => (selectedBan = selectedBan === b.steamId ? null : b.steamId)}
						>
							<td class="font-mono">
								<a
									href="/server/{encodeURIComponent(id)}/players/{b.steamId}"
									class="hover:text-accent hover:underline"
									title="Open dossier"
									onclick={(e) => e.stopPropagation()}>{b.steamId}</a
								>
							</td>
							<td>
								{#if src?.managed}
									<Badge tone={STATE_TONE[src.state]}
										>org{src.state === 'failed' ? ' · failed' : ''}</Badge
									>
								{:else}
									<Badge>local</Badge>
								{/if}
							</td>
							<td class="font-mono text-[12px] text-mist-400">{b.bannedAtUtc || '—'}</td>
							<td>{b.bannedBy}</td>
							<td
								>{#if b.reason}{b.reason}{:else}<span class="text-mist-600">—</span>{/if}</td
							>
						</tr>
					{:else}
						<tr><td colspan="5" class="py-6 text-center text-mist-600">No bans.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			<Badge tone="ok">org</Badge> bans come from the organisation's ban list and are re-applied if removed
			here; <Badge>local</Badge> bans were added on this server and the panel leaves them alone. To ban
			someone who is playing right now, use the Players tab.
		</p>
	</div>
</div>

{#if banning}
	<BanDialog
		orgId={data.server.orgId}
		orgName={data.server.orgName}
		server={{ id, name: data.server.name }}
		canOrg={listState?.canEditOrg ?? false}
		onclose={() => (banning = false)}
		ondone={refreshAll}
	/>
{/if}
