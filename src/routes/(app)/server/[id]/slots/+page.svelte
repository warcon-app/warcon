<script lang="ts">
	// Who holds a reserved slot on this server: the roster as the game server holds it, with what
	// the organisation's list and this server's own list contribute marked out, who is playing
	// right now, and the controls to hand out or withdraw a slot here. A slot reserved here goes
	// on the server's own list, so the panel applies it and lifts it at its expiry.
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { api, rconGet, rconPost, errorMessage } from '$lib/api';
	import { watchLive } from '$lib/live';
	import { fmtTime } from '$lib/format';
	import { can } from '$lib/capabilities';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import SteamName from '$lib/components/SteamName.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { TableSort, matches } from '$lib/table.svelte';
	import { isSteamId, steamProfiles, type SteamProfile } from '$lib/steam-profiles';
	import { describeSync, EXPIRY_OPTIONS, expiryIso, STATE_TONE } from '$lib/lists';
	import type { ListSyncServer, ServerListsState } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let admin = $derived(can(data.server.caps, 'slots.manage'));
	let listsEdit = $derived(can(data.server.caps, 'lists.reserve'));
	let orgPath = $derived(`/orgs/${encodeURIComponent(data.server.orgId)}`);
	// Builds without the live routes take reserved slots through the config document instead.
	let viaConfig = $derived(!data.features.reservedSlots && data.features.configDocument);
	let canReserve = $derived(admin && (data.features.reservedSlots || viaConfig));

	let listState = $state<ServerListsState | null>(null);
	$effect(() => {
		listState = data.listState;
	});
	/** SteamIDs the game server holds a slot for right now */
	let reserved = $state<string[]>([]);
	/**
	 * DefaultReservedPlayerIds as the config document has it, on builds where the panel edits the
	 * document (null otherwise). The live builds load it at start, so the two disagree between an
	 * edit and the next restart: shown as "arrives at restart" / "leaves at restart".
	 */
	let document = $state<string[] | null>(null);
	let reservedId = $state('');
	let newNote = $state('');
	let newExpiry = $state('0');
	let newCustom = $state('');
	let search = $state('');
	let busy = $state(false);
	/** who is on the server right now, by SteamID, with the name they are playing under */
	let online = $state<Record<string, string>>({});
	/** Steam personas for slot holders the panel has not seen play, where a key is configured */
	let steam = $state<Record<string, SteamProfile | null>>({});
	/** the persona for the id being typed into the reserve form: undefined while unknown */
	let preview = $state<SteamProfile | null | undefined>(undefined);
	let previewId = $derived(isSteamId(reservedId.trim()) ? reservedId.trim() : '');

	let orgReserveCount = $derived(
		data.orgLists?.lists.find((l) => l.kind === 'reserve')?.entryCount ?? null
	);
	let managedSlots = $derived(
		Object.values(listState?.reserved ?? {}).filter((s) => s.managed && s.scope === 'org').length
	);
	let hereSlots = $derived(
		Object.values(listState?.reserved ?? {}).filter((s) => s.managed && s.scope === 'server').length
	);
	let pendingCount = $derived(
		Object.values(listState?.reserved ?? {}).filter(
			(s) => s.state === 'pending' || s.state === 'failed'
		).length
	);
	/** MaxReservedSlots: player slots held back for reserved players; null until the worker read it */
	let heldSlots = $state<number | null>(null);
	/** the public cap the server reports (MaxPlayers less the held slots); null until seen */
	let publicSlots = $state<number | null>(null);
	let slotSource = (steamId: string) => listState?.reserved[steamId] ?? null;

	/**
	 * The roster: everyone holding a slot on this server, plus list entries still on their way.
	 * People playing right now come first, then the org's hand-picked entries, then this server's
	 * own, then slots added outside the panel, then members.
	 */
	let slots = $derived.by(() => {
		const ids = new Set([
			...reserved,
			...(document ?? []),
			...Object.keys(listState?.reserved ?? {})
		]);
		const rows = [...ids].flatMap((steamId) => {
			const src = slotSource(steamId);
			const here = reserved.includes(steamId);
			const inDocument = document?.includes(steamId) ?? here;
			// A slot no org list manages that the server no longer reports (nor the document) is a
			// stale copy, withdrawn from the official console or here a moment ago: nothing to show.
			if (src && !src.managed && !here && !inDocument) return [];
			return {
				steamId,
				src,
				here,
				/** the document and the running server disagree until the server restarts */
				pending: here && !inDocument ? 'leaves' : !here && inDocument ? 'arrives' : null,
				name: online[steamId] ?? src?.name ?? steam[steamId]?.name ?? null,
				online: steamId in online,
				rank: src?.member ? 4 : !src?.managed ? 3 : src.scope === 'server' ? 2 : 1
			};
		});
		return rows.sort(
			(a, b) =>
				Number(b.online) - Number(a.online) ||
				a.rank - b.rank ||
				(a.name ?? '￿').localeCompare(b.name ?? '￿') ||
				a.steamId.localeCompare(b.steamId)
		);
	});
	/** a column sort on top of that order; clicking the active header a third time restores it */
	const sort = new TableSort<(typeof slots)[number]>({
		player: { by: (s) => s.name },
		steamId: { by: (s) => s.steamId },
		source: { by: (s) => s.rank },
		note: { by: (s) => s.src?.note },
		expires: { by: (s) => s.src?.expiresAt ?? '' }
	});
	let rows = $derived(
		sort.sorted(slots.filter((s) => matches(search, s.steamId, s.name, s.src?.note)))
	);
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
		const r = await rconGet<{ reserved: string[]; document?: string[] | null }>(
			id,
			'reserved',
			viaConfig ? { document: 1 } : undefined
		);
		reserved = r.reserved;
		document = viaConfig ? (r.document ?? null) : null;
		void refreshListState();
	}
	const refreshAll = () => Promise.all([refreshReserved(), invalidateAll()]);

	$effect(() => {
		void id;
		refreshReserved().catch((err) => toast(errorMessage(err), 'err'));
	});
	// Personas are looked up for the roster's ids alone, so a lookup never re-runs on its own result.
	let slotIds = $derived(
		[...new Set([...reserved, ...(document ?? []), ...Object.keys(listState?.reserved ?? {})])]
			.sort()
			.join(',')
	);
	$effect(() => {
		const ids = slotIds.split(',').filter(Boolean);
		untrack(() => void lookupSteam(ids));
	});
	async function lookupSteam(ids: string[]) {
		const found = await steamProfiles(ids.filter((s) => !(s in steam)));
		if (Object.keys(found).length) steam = { ...steam, ...found };
	}
	$effect(() => {
		const want = previewId;
		preview = undefined;
		if (!want) return;
		void steamProfiles([want]).then((r) => {
			if (previewId === want && want in r) preview = r[want];
		});
	});
	$effect(() => {
		void id;
		return watchLive([id], (v) => {
			const next: Record<string, string> = {};
			for (const p of v.players) next[p.steamId] = p.name;
			online = next;
			heldSlots = v.reservedSlots;
			publicSlots = v.status?.maxPlayers ?? null;
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
	/** Reserves through the server's own list; the panel applies it now and lifts it at the expiry. */
	async function addSlot() {
		const steamId = reservedId.trim();
		busy = true;
		try {
			const res = await api<{ sync: ListSyncServer }>(
				'POST',
				`/api/servers/${encodeURIComponent(id)}/lists/reserve/entries`,
				{ steamId, reason: newNote.trim(), expiresAt: expiryIso(newExpiry, newCustom) }
			);
			toast(describeSync({ servers: [res.sync] }, `Reserved a slot for ${steamId}.`), 'ok', 8000);
			reservedId = '';
			newNote = '';
			newExpiry = '0';
			newCustom = '';
			await refreshReserved();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
	async function removeSlot(steamId: string, name: string | null) {
		const src = slotSource(steamId);
		const who = name ? `${name} (${steamId})` : steamId;
		if (src?.managed && src.scope === 'server') {
			if (!(await confirmDialog(`Withdraw the reserved slot for ${who}?`, { okLabel: 'Do it' })))
				return;
			busy = true;
			try {
				const res = await api<{ sync: ListSyncServer }>(
					'DELETE',
					`/api/servers/${encodeURIComponent(id)}/lists/reserve/entries/${steamId}`
				);
				toast(describeSync({ servers: [res.sync] }, `Withdrew the slot for ${who}.`), 'ok', 8000);
				await refreshReserved();
			} catch (err) {
				toast(errorMessage(err), 'err');
			} finally {
				busy = false;
			}
			return;
		}
		await act(
			'reservedRemove',
			{ steamId, viaConfig },
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
				>{reserved.length}</span
			>
			{#if onlineSlots}
				<span class="ml-auto inline-flex items-center gap-1.5 text-[12.5px] text-ok"
					><span class="size-1.5 rounded-full bg-ok"></span>{onlineSlots} playing now</span
				>
			{/if}
		</div>
		{#if heldSlots !== null}
			<div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
				<span
					><span class="text-mist-400">Player slots</span>
					<b>{publicSlots ?? '—'}</b> public + <b>{heldSlots}</b> reserved{#if publicSlots !== null}
						= {publicSlots + heldSlots}{/if}</span
				>
			</div>
		{/if}
		<p class="note">
			Anyone on the list skips the join queue, and the list has no length limit. MaxReservedSlots
			only sets how many player slots are held back for them.
		</p>
	</div>

	<div class="panel">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<span class="label-sm mb-0!">From the organisation · {data.server.orgName}</span>
			<span class="ml-auto inline-flex flex-wrap gap-1.5">
				{#if listState?.canEditOrgSlots}
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
			<span><b>{hereSlots}</b> reserved here</span>
			<span><b>{localSlots}</b> added outside the panel</span>
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
			class="space-y-2"
			onsubmit={(e) => {
				e.preventDefault();
				void addSlot();
			}}
		>
			<div class="join w-full">
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
				<button
					type="submit"
					class="btn btn-primary"
					disabled={!canReserve || busy || !isSteamId(reservedId.trim())}>Reserve</button
				>
			</div>
			{#if previewId && preview}
				<div class="text-[12.5px]"><SteamName profile={preview} /></div>
			{:else if previewId && preview === null}
				<div class="text-[12.5px] text-mist-600">No Steam profile for that id.</div>
			{/if}
			<input
				class="input"
				type="text"
				maxlength="200"
				placeholder="Note, e.g. donor, clan member (optional)"
				disabled={!canReserve}
				bind:value={newNote}
			/>
			<div class="flex flex-wrap gap-2">
				<label class="block sm:w-40"
					><span class="field-label">Expires</span><select
						class="input"
						disabled={!canReserve}
						bind:value={newExpiry}
					>
						{#each EXPIRY_OPTIONS as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select></label
				>
				{#if newExpiry === 'custom'}
					<label class="block sm:flex-1"
						><span class="field-label">Until (local time)</span><input
							class="input"
							type="datetime-local"
							bind:value={newCustom}
							required
						/></label
					>
				{/if}
			</div>
		</form>
		<p class="note">
			{#if !data.features.reservedSlots && !viaConfig}
				This server build has no live reserved-slot routes and no writable config document, so
				nothing can be reserved from here.
			{:else}
				On this server only; a slot with an expiry is withdrawn by the panel when the time comes.
				{#if viaConfig}
					This build has no live reserved-slot routes, so the panel writes the slot to
					+DefaultReservedPlayerIds in its config document, taken up at the next restart.
				{/if}
				{#if listState?.canEditOrgSlots}To reserve a slot on every server, use the organisation
					list.{/if}
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
				<thead>
					<tr>
						<SortHeader {sort} key="player">Player</SortHeader>
						<SortHeader {sort} key="steamId">SteamID64</SortHeader>
						<SortHeader {sort} key="source">Source</SortHeader>
						<SortHeader {sort} key="note">Note</SortHeader>
						<SortHeader {sort} key="expires">Expires</SortHeader>
						<th></th>
					</tr>
				</thead>
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
									{#if steam[s.steamId]?.avatar}<img
											src={steam[s.steamId]?.avatar}
											alt=""
											class="size-5 shrink-0 rounded-sm"
											loading="lazy"
											referrerpolicy="no-referrer"
										/>{/if}
									<a
										href="/server/{encodeURIComponent(id)}/players/{s.steamId}"
										data-sveltekit-preload-data="tap"
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
										>{s.src.scope === 'server' ? 'here' : 'org'}{s.src.state === 'applied'
											? ''
											: ` · ${s.src.state}`}</Badge
									>
									<!-- the group it comes from, for staff (null for everyone else) -->
									{#if s.src.group}<span class="ml-1 text-[12.5px] text-mist-400"
											>{s.src.group}</span
										>{/if}
								{:else if s.pending !== 'leaves'}
									<!-- a slot on its way out reads as just that, not as someone else's -->
									<Badge>local</Badge>
								{/if}
								{#if s.pending === 'leaves'}
									<Badge
										tone="warn"
										class="ml-1"
										title="Removed from the config document; the running server keeps the slot until it restarts"
										>leaves at restart</Badge
									>
								{:else if s.pending === 'arrives'}
									<Badge
										tone="warn"
										class="ml-1"
										title="In the config document; the running server takes the slot up when it restarts"
										>arrives at restart</Badge
									>
								{/if}
							</td>
							<td
								>{#if s.src?.note}{s.src.note}{:else}<span class="text-mist-600">—</span>{/if}</td
							>
							<td class="whitespace-nowrap text-mist-400"
								>{#if s.src?.expiresAt}{fmtTime(s.src.expiresAt)}{:else}<span class="text-mist-600"
										>—</span
									>{/if}</td
							>
							<td class="text-right">
								{#if canReserve && ((s.src?.managed && s.src.scope === 'server') || ((s.here || s.pending === 'arrives') && s.pending !== 'leaves'))}
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
			and are handed back if withdrawn here; <Badge tone="ok">here</Badge> slots were reserved on this
			server through the panel, which lifts them at their expiry; <Badge>local</Badge> slots were added
			outside the panel and it leaves them alone.{#if viaConfig}
				This build reads its reserved list from the config document at start, so a slot reserved or
				withdrawn here is marked until the server restarts.{/if}
		</p>
	{:else}
		<div class="callout mb-0">
			<b>Nobody holds a reserved slot here yet.</b>
			<span class="block text-mist-400"
				>A reserved slot lets your admins, donors and clan members skip the queue when the server is
				full. Reserve one above{#if listState?.canEditOrgSlots}, or hand them out across every
					server from the organisation's list{/if}.</span
			>
		</div>
	{/if}
</div>
