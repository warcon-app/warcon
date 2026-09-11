<script lang="ts">
	// This server's ban list and reserved slots as the game server holds them, with what the
	// organisation's lists contribute marked out, and the way into those lists.
	import { invalidateAll } from '$app/navigation';
	import { api, rconGet, rconPost, errorMessage } from '$lib/api';
	import { watchLive } from '$lib/live';
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
	/** who is on the server right now, by SteamID, with the name they are playing under */
	let online = $state<Record<string, string>>({});

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
	let slotCap = $derived(listState?.sync?.reservedCap ?? null);
	let slotPct = $derived(
		slotCap ? Math.min(100, Math.round((reserved.length / slotCap) * 100)) : 0
	);
	/**
	 * The roster: everyone holding a slot on this server, plus org entries still on their way.
	 * People playing right now come first, then the org's hand-picked entries, then slots added
	 * on this server, then members (who rank below everyone else when the cap bites).
	 */
	let slots = $derived.by(() => {
		const ids = new Set([...reserved, ...Object.keys(listState?.reserved ?? {})]);
		const rows = [...ids].map((steamId) => {
			const src = listState?.reserved[steamId] ?? null;
			const here = reserved.includes(steamId);
			return {
				steamId,
				src,
				here,
				name: online[steamId] ?? src?.name ?? null,
				online: steamId in online,
				rank: src?.member ? 3 : src?.managed ? 1 : 2
			};
		});
		return rows.sort(
			(a, b) =>
				Number(b.online) - Number(a.online) ||
				a.rank - b.rank ||
				(b.src?.priority ?? 0) - (a.src?.priority ?? 0) ||
				(a.name ?? '\uffff').localeCompare(b.name ?? '\uffff') ||
				a.steamId.localeCompare(b.steamId)
		);
	});
	let onlineSlots = $derived(slots.filter((s) => s.online).length);
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
	$effect(() => {
		void id;
		return watchLive([id], (v) => {
			const next: Record<string, string> = {};
			for (const p of v.players) next[p.steamId] = p.name;
			online = next;
		});
	});

	const addSlot = () =>
		act(
			'reservedAdd',
			{ steamId: reservedId.trim() },
			{
				after: async () => {
					reservedId = '';
					await refreshReserved();
				}
			}
		);
	async function removeSlot(steamId: string, name: string | null) {
		const src = slotSource(steamId);
		const who = name ? `${name} (${steamId})` : steamId;
		await act(
			'reservedRemove',
			{ steamId },
			{
				confirm: src?.managed
					? `${who} holds this slot through the organisation's list, so the panel will hand it back at the next sync. Withdraw it here anyway? To withdraw it everywhere, remove it from the organisation's reserved slots instead.`
					: `Withdraw the reserved slot for ${who}?`,
				danger: !!src?.managed,
				after: refreshReserved
			}
		);
	}

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
	<div class="flex flex-col panel">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<span class="label-sm mb-0!">Reserved slots</span>
			{#if listState?.canEditOrg}
				<a class="ml-auto btn btn-sm" href="{orgPath}/reserved">Organisation list</a>
			{/if}
		</div>
		<div class="mb-4 rounded-card border border-black bg-ink-950 px-4 py-3">
			<div class="flex items-baseline gap-2">
				<span class="font-display text-[28px] leading-none font-semibold tabular"
					>{reserved.length}{#if slotCap !== null}<span class="text-mist-600"
							>&nbsp;/ {slotCap}</span
						>{/if}</span
				>
				<span class="caps text-mist-400">slots held</span>
				{#if onlineSlots}
					<span class="ml-auto inline-flex items-center gap-1.5 text-[12.5px] text-ok"
						><span class="size-1.5 rounded-full bg-ok"></span>{onlineSlots} playing now</span
					>
				{/if}
			</div>
			{#if slotCap !== null}
				<div class="mt-2.5 progress">
					<span class="progress-bar" style="width: {slotPct}%"></span>
				</div>
				<div class="mt-1.5 text-[12px] text-mist-400">
					{#if slotCap - reserved.length > 0}
						{slotCap - reserved.length} more can be handed out before this server's cap (MaxReservedSlots).
					{:else}
						The cap is full: higher-priority org entries push out lower ones.
					{/if}
				</div>
			{/if}
		</div>

		{#if slots.length}
			<ul class="mb-4 divide-y divide-white/[0.06] rounded-card border border-black bg-ink-950">
				{#each slots as s (s.steamId)}
					<li
						class="group flex items-center gap-3 px-3 py-2 {s.src?.managed && !s.here
							? 'opacity-70'
							: ''}"
					>
						<span
							class="size-2 shrink-0 rounded-full {s.online
								? 'bg-ok ring-[3px] ring-ok/25'
								: 'bg-ink-700'}"
							title={s.online ? 'Playing now' : 'Not on the server right now'}
						></span>
						<div class="min-w-0 flex-1">
							<div class="flex min-w-0 items-center gap-2">
								<a
									href="/server/{encodeURIComponent(id)}/players/{s.steamId}"
									class="truncate text-[13.5px] font-medium hover:text-accent hover:underline {s.name
										? ''
										: 'text-mist-400 italic'}"
									title="Open dossier">{s.name ?? 'Not seen here yet'}</a
								>
								{#if s.src?.member}
									<Badge tone="accent">member</Badge>
								{:else if s.src?.managed}
									<Badge tone={STATE_TONE[s.src.state]}
										>org{s.src.state === 'applied' ? '' : ` · ${s.src.state}`}</Badge
									>
								{:else}
									<Badge>local</Badge>
								{/if}
							</div>
							<div class="flex flex-wrap gap-x-1.5 text-[11.5px] text-mist-600">
								<span class="font-mono">{s.steamId}</span>
								{#if s.src?.note}<span class="text-mist-400">{s.src.note}</span>{/if}
							</div>
						</div>
						{#if admin && data.features.reservedSlots && s.here}
							<button
								type="button"
								class="btn btn-sm btn-ghost opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
								title="Withdraw this slot"
								onclick={() => removeSlot(s.steamId, s.name)}>Withdraw</button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<div class="callout mb-4">
				<b>Nobody holds a reserved slot here yet.</b>
				<span class="block text-mist-400"
					>A reserved slot lets your admins, donors and clan members join even when the server is
					full. Reserve one below{#if listState?.canEditOrg}, or hand them out across every server
						from the organisation's list{/if}.</span
				>
			</div>
		{/if}

		<form
			class="join join-wrap mt-auto w-full"
			onsubmit={(e) => {
				e.preventDefault();
				void addSlot();
			}}
		>
			<input
				class="input font-mono"
				type="text"
				inputmode="numeric"
				placeholder="SteamID64 to reserve…"
				maxlength="17"
				required
				bind:value={reservedId}
			/>
			<button
				type="submit"
				class="btn btn-primary"
				disabled={!admin || !data.features.reservedSlots || !reservedId.trim()}>Reserve</button
			>
		</form>
		<p class="note">
			{#if !data.features.reservedSlots}This server build has no live reserved-slot routes; add
				+DefaultReservedPlayerIds lines to the config document instead.{/if}
			Slots reserved here are written to this server's ServerSettings.ini only. <Badge tone="ok"
				>org</Badge
			> and <Badge tone="accent">member</Badge> slots come from the organisation and are handed back if
			withdrawn here.
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
