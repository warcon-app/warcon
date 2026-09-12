<script lang="ts">
	// Who holds a reserved slot on this server: the roster as the game server holds it, with what
	// the organisation's list contributes marked out, who is playing right now, and the controls
	// to hand out or withdraw a slot here.
	import { invalidateAll } from '$app/navigation';
	import { api, rconGet, rconPost, errorMessage } from '$lib/api';
	import { watchLive } from '$lib/live';
	import { fmtTime } from '$lib/format';
	import { can } from '$lib/capabilities';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import { describeSync, STATE_TONE } from '$lib/lists';
	import type { ListSyncServer, ServerListsState } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let admin = $derived(can(data.server.caps, 'slots.manage'));
	let listsEdit = $derived(can(data.server.caps, 'lists.edit'));
	let orgPath = $derived(`/orgs/${encodeURIComponent(data.server.orgId)}`);
	let canReserve = $derived(admin && data.features.reservedSlots);

	let listState = $state<ServerListsState | null>(null);
	$effect(() => {
		listState = data.listState;
	});
	/** SteamIDs the game server holds a slot for right now */
	let reserved = $state<string[]>([]);
	let reservedId = $state('');
	let search = $state('');
	let busy = $state(false);
	/** who is on the server right now, by SteamID, with the name they are playing under */
	let online = $state<Record<string, string>>({});

	let orgReserveCount = $derived(
		data.orgLists?.lists.find((l) => l.kind === 'reserve')?.entryCount ?? null
	);
	let managedSlots = $derived(
		Object.values(listState?.reserved ?? {}).filter((s) => s.managed).length
	);
	let pendingCount = $derived(
		Object.values(listState?.reserved ?? {}).filter(
			(s) => s.state === 'pending' || s.state === 'failed'
		).length
	);
	let slotCap = $derived(listState?.sync?.reservedCap ?? null);
	let slotPct = $derived(
		slotCap ? Math.min(100, Math.round((reserved.length / slotCap) * 100)) : 0
	);
	let slotSource = (steamId: string) => listState?.reserved[steamId] ?? null;

	/**
	 * The roster: everyone holding a slot on this server, plus org entries still on their way.
	 * People playing right now come first, then the org's hand-picked entries, then slots added
	 * on this server, then members (who rank below everyone else when the cap bites).
	 */
	let slots = $derived.by(() => {
		const ids = new Set([...reserved, ...Object.keys(listState?.reserved ?? {})]);
		const rows = [...ids].map((steamId) => {
			const src = slotSource(steamId);
			return {
				steamId,
				src,
				here: reserved.includes(steamId),
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
				(a.name ?? '￿').localeCompare(b.name ?? '￿') ||
				a.steamId.localeCompare(b.steamId)
		);
	});
	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return slots.filter(
			(s) =>
				!q ||
				s.steamId.includes(q) ||
				(s.name ?? '').toLowerCase().includes(q) ||
				(s.src?.note ?? '').toLowerCase().includes(q)
		);
	});
	let onlineSlots = $derived(slots.filter((s) => s.online).length);
	let localSlots = $derived(slots.filter((s) => s.here && !s.src?.managed).length);

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
	const refreshAll = () => Promise.all([refreshReserved(), invalidateAll()]);

	$effect(() => {
		void id;
		refreshReserved().catch((err) => toast(errorMessage(err), 'err'));
	});
	$effect(() => {
		void id;
		return watchLive([id], (v) => {
			const next: Record<string, string> = {};
			for (const p of v.players) next[p.steamId] = p.name;
			online = next;
		});
	});

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
</script>

<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
	<div class="panel">
		<span class="label-sm">Slots held</span>
		<div class="flex items-baseline gap-2">
			<span class="font-display text-[34px] leading-none font-semibold tabular"
				>{reserved.length}{#if slotCap !== null}<span class="text-mist-600">&nbsp;/ {slotCap}</span
					>{/if}</span
			>
			{#if onlineSlots}
				<span class="ml-auto inline-flex items-center gap-1.5 text-[12.5px] text-ok"
					><span class="size-1.5 rounded-full bg-ok"></span>{onlineSlots} playing now</span
				>
			{/if}
		</div>
		{#if slotCap !== null}
			<div class="mt-3 progress"><span class="progress-bar" style="width: {slotPct}%"></span></div>
			<p class="note">
				{#if slotCap - reserved.length > 0}
					{slotCap - reserved.length} more can be handed out before this server's cap (MaxReservedSlots).
				{:else}
					The cap is full: higher-priority organisation entries push out lower ones.
				{/if}
			</p>
		{:else}
			<p class="note">This server's cap (MaxReservedSlots) is not known until the first sync.</p>
		{/if}
	</div>

	<div class="panel">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<span class="label-sm mb-0!">From the organisation · {data.server.orgName}</span>
			<span class="ml-auto inline-flex flex-wrap gap-1.5">
				{#if listState?.canEditOrg}
					<a class="btn btn-sm" href="{orgPath}/reserved">Organisation list</a>
				{/if}
				{#if listsEdit}
					<button class="btn btn-sm" disabled={busy} onclick={syncNow}>Sync now</button>
				{/if}
			</span>
		</div>
		<div class="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
			{#if orgReserveCount !== null}
				<span
					><b>{orgReserveCount}</b> on the organisation list, <b>{managedSlots}</b> applied here</span
				>
			{:else}
				<span><b>{managedSlots}</b> applied here by the organisation</span>
			{/if}
			<span><b>{localSlots}</b> local to this server</span>
			{#if pendingCount}<Badge tone="warn">{pendingCount} pending or failed</Badge>{/if}
		</div>
		<div class="mt-1 text-[12.5px] text-mist-400">
			{#if listState?.sync?.syncedAt}
				Last synced {fmtTime(listState.sync.syncedAt)}.
			{:else}
				Not synced yet.
			{/if}
			{#if listState?.sync?.lastError}<span class="text-danger">
					{listState.sync.lastError}</span
				>{/if}
		</div>
	</div>

	<div class="flex flex-col panel">
		<span class="label-sm">Reserve a slot here</span>
		<form
			class="join join-wrap w-full"
			onsubmit={(e) => {
				e.preventDefault();
				void addSlot();
			}}
		>
			<input
				class="input font-mono"
				type="text"
				inputmode="numeric"
				placeholder="SteamID64…"
				maxlength="17"
				required
				disabled={!canReserve}
				bind:value={reservedId}
			/>
			<button type="submit" class="btn btn-primary" disabled={!canReserve || !reservedId.trim()}
				>Reserve</button
			>
		</form>
		<p class="note">
			{#if !data.features.reservedSlots}
				This server build has no live reserved-slot routes; add +DefaultReservedPlayerIds lines to
				the config document instead.
			{:else if listState?.canEditOrg}
				Written to this server's ServerSettings.ini only. To reserve a slot on every server, use the
				organisation list.
			{:else}
				Written to this server's ServerSettings.ini only.
			{/if}
		</p>
	</div>
</div>

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<span class="label-sm mb-0!">Who holds a slot</span>
		<div class="join w-full sm:ml-auto sm:w-auto sm:min-w-[320px]">
			<input
				class="input"
				type="search"
				placeholder="Filter by name, SteamID, note…"
				bind:value={search}
			/>
			<button
				class="btn"
				onclick={() => refreshReserved().catch((e) => toast(errorMessage(e), 'err'))}
				>Refresh</button
			>
		</div>
	</div>
	{#if slots.length}
		<div class="table-wrap">
			<table>
				<thead
					><tr
						><th>Player</th><th>SteamID64</th><th>Source</th><th>Note</th><th class="num"
							>Priority</th
						><th></th></tr
					></thead
				>
				<tbody>
					{#each rows as s (s.steamId)}
						<tr class={s.src?.managed && !s.here ? 'opacity-70' : ''}>
							<td>
								<span class="inline-flex min-w-0 items-center gap-2.5">
									<span
										class="size-2 shrink-0 rounded-full {s.online
											? 'bg-ok ring-[3px] ring-ok/25'
											: 'bg-ink-700'}"
										title={s.online ? 'Playing now' : 'Not on the server right now'}
									></span>
									<a
										href="/server/{encodeURIComponent(id)}/players/{s.steamId}"
										class="truncate font-medium hover:text-accent hover:underline {s.name
											? ''
											: 'text-mist-400 italic'}"
										title="Open dossier">{s.name ?? 'Not seen here yet'}</a
									>
									{#if s.online}<span class="caps text-[10px] text-ok">playing</span>{/if}
								</span>
							</td>
							<td class="font-mono text-[12.5px] text-mist-400">{s.steamId}</td>
							<td>
								{#if s.src?.member}
									<Badge tone="accent">member</Badge>
								{:else if s.src?.managed}
									<Badge tone={STATE_TONE[s.src.state]}
										>org{s.src.state === 'applied' ? '' : ` · ${s.src.state}`}</Badge
									>
								{:else}
									<Badge>local</Badge>
								{/if}
							</td>
							<td
								>{#if s.src?.note}{s.src.note}{:else}<span class="text-mist-600">—</span>{/if}</td
							>
							<td class="num text-mist-400"
								>{#if s.src?.member}<span class="text-mist-600">member</span
									>{:else if s.src?.priority !== null && s.src?.priority !== undefined}{s.src
										.priority}{:else}<span class="text-mist-600">—</span>{/if}</td
							>
							<td class="text-right">
								{#if canReserve && s.here}
									<button
										type="button"
										class="btn btn-sm btn-ghost"
										title="Withdraw this slot"
										onclick={() => removeSlot(s.steamId, s.name)}>Withdraw</button
									>
								{/if}
							</td>
						</tr>
					{:else}
						<tr
							><td colspan="6" class="py-6 text-center text-mist-600"
								>Nobody matches that filter.</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			<Badge tone="ok">org</Badge> and <Badge tone="accent">member</Badge> slots come from the organisation
			and are handed back if withdrawn here; <Badge>local</Badge> slots were reserved on this server and
			the panel leaves them alone. When a server's cap is full, higher priority wins and members rank
			below every explicit entry.
		</p>
	{:else}
		<div class="callout mb-0">
			<b>Nobody holds a reserved slot here yet.</b>
			<span class="block text-mist-400"
				>A reserved slot lets your admins, donors and clan members join even when the server is
				full. Reserve one above{#if listState?.canEditOrg}, or hand them out across every server
					from the organisation's list{/if}.</span
			>
		</div>
	{/if}
</div>
