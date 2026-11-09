<script lang="ts">
	// The organisation's reserved-slot list, laid out like a server's Reserved slots tab: how many
	// hold a slot and who is playing right now, where the list stands on each server, the form to
	// hand out a slot everywhere, and the roster itself. With `group`, the same for one of its
	// reserved-slot groups, on the servers the group is for, under the group's own controls.
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { watchLive } from '$lib/live';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { describeSync, EXPIRY_OPTIONS, expiryIso, STATE_TEXT, STATE_TONE } from '$lib/lists';
	import { isSteamId, steamProfiles, type SteamProfile } from '$lib/steam-profiles';
	import Badge from '$lib/components/Badge.svelte';
	import SteamName from '$lib/components/SteamName.svelte';
	import ImportCandidates from './ImportCandidates.svelte';
	import ReserveTabs from './ReserveTabs.svelte';
	import GroupBar from './GroupBar.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { TableSort, matches } from '$lib/table.svelte';
	import type { ListEntryView, ListSyncSummary, OrgListsView, SlotGroupView } from '$lib/types';

	let {
		entries,
		lists,
		org,
		servers,
		group = null
	}: {
		entries: ListEntryView[];
		lists: OrgListsView;
		org: { id: string; name: string };
		/** the org's servers this user may open: who is playing is watched on these */
		servers: { id: string; name: string }[];
		/** one of the org's reserved-slot groups, shown in place of its own list */
		group?: SlotGroupView | null;
	} = $props();

	let path = $derived(
		group
			? `/api/orgs/${encodeURIComponent(org.id)}/slot-groups/${encodeURIComponent(group.id)}/entries`
			: `/api/orgs/${encodeURIComponent(org.id)}/lists/reserve/entries`
	);
	/** a group switched off (or set for later) has no slots anywhere: its servers say so */
	let groupOff = $derived(!!group && !group.on);
	let where = $derived(
		group
			? group.everyServer
				? `every server in ${org.name}`
				: group.servers.map((s) => s.name).join(', ') || 'no server'
			: ''
	);
	let owner = $derived(lists.role === 'owner');
	let search = $state('');
	let busy = $state(false);
	let newId = $state('');
	let newReason = $state('');
	let newExpiry = $state('0');
	let newCustom = $state('');
	/** Steam personas, for the avatar beside a name */
	let steam = $state<Record<string, SteamProfile | null>>({});
	/** the persona for the id being typed into the reserve form: undefined while unknown */
	let preview = $state<SteamProfile | null | undefined>(undefined);
	let previewId = $derived(isSteamId(newId.trim()) ? newId.trim() : '');
	/** the worker's latest player list per server, by server id */
	let playersOn = $state<Record<string, { steamId: string; name: string }[]>>({});
	/** who is playing right now, by SteamID: the name they play under and where */
	let online = $derived.by(() => {
		const out: Record<string, { name: string; servers: string[] }> = {};
		for (const s of servers)
			for (const p of playersOn[s.id] ?? [])
				(out[p.steamId] ??= { name: p.name, servers: [] }).servers.push(s.name);
		return out;
	});

	let picked = $derived(entries.filter((e) => !e.member).length);
	let members = $derived(entries.length - picked);
	let playing = $derived(entries.filter((e) => e.steamId in online).length);
	/** where the list stands on each server: how many entries the panel has applied there */
	let standing = $derived(
		lists.servers
			.filter((s) => !group || group.servers.some((g) => g.id === s.id))
			.map((s) => {
				const states = entries.map((e) => e.servers.find((x) => x.serverId === s.id)?.state);
				return {
					...s,
					applied: states.filter((st) => st === 'applied' || st === 'local').length,
					pending: states.filter((st) => st === 'pending' || st === 'failed').length,
					href: servers.some((x) => x.id === s.id)
						? `/server/${encodeURIComponent(s.id)}/slots`
						: null
				};
			})
	);
	let dossierBase = $derived(
		servers.length ? `/server/${encodeURIComponent(servers[0].id)}/players` : null
	);

	/**
	 * The roster: people playing right now first, then slots handed out by hand, then members.
	 */
	let roster = $derived(
		entries
			.map((e) => {
				const live = online[e.steamId];
				return {
					e,
					live,
					name: live?.name ?? e.name ?? steam[e.steamId]?.name ?? null,
					avatar: steam[e.steamId]?.avatar ?? ''
				};
			})
			.sort(
				(a, b) =>
					Number(!!b.live) - Number(!!a.live) ||
					Number(a.e.member) - Number(b.e.member) ||
					(a.name ?? '￿').localeCompare(b.name ?? '￿') ||
					a.e.steamId.localeCompare(b.e.steamId)
			)
	);
	/** a column sort on top of that order; clicking the active header a third time restores it */
	const sort = new TableSort<(typeof roster)[number]>({
		player: { by: (r) => r.name },
		steamId: { by: (r) => r.e.steamId },
		source: { by: (r) => (r.e.member ? 'member' : 'list') },
		note: { by: (r) => r.e.reason },
		added: { by: (r) => (r.e.member ? null : r.e.addedAt), dir: 'desc' },
		// slots that never expire last, then the soonest to lapse first
		expires: { by: (r) => r.e.expiresAt ?? '\uffff' },
		servers: { by: (r) => r.e.servers.filter((s) => s.state === 'applied').length, dir: 'desc' }
	});
	let rows = $derived(
		sort.sorted(
			roster.filter((r) => matches(search, r.e.steamId, r.name, r.e.reason, r.e.addedByName))
		)
	);

	$effect(() => {
		const ids = servers.map((s) => s.id);
		return watchLive(
			ids,
			(v) => {
				playersOn[v.serverId] = v.ok
					? v.players.map((p) => ({ steamId: p.steamId, name: p.name }))
					: [];
			},
			undefined,
			undefined,
			{ org: org.id, players: true }
		);
	});
	// Personas are looked up for the list's ids alone, so a lookup never re-runs on its own result.
	let listIds = $derived(
		entries
			.map((e) => e.steamId)
			.sort()
			.join(',')
	);
	$effect(() => {
		const ids = listIds.split(',').filter(Boolean);
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

	async function addReserved() {
		const steamId = newId.trim();
		if (!isSteamId(steamId)) {
			toast('Enter a 17-digit SteamID64.', 'err');
			return;
		}
		busy = true;
		try {
			const res = await api<{ sync: ListSyncSummary }>('POST', path, {
				steamId,
				reason: newReason.trim(),
				expiresAt: expiryIso(newExpiry, newCustom)
			});
			toast(
				group
					? groupOff
						? `Added ${steamId} to ${group.name}. They get the slot when it is switched on.`
						: describeSync(res.sync, `Added ${steamId} to ${group.name}.`)
					: describeSync(res.sync, `Reserved a slot for ${steamId}.`),
				'ok',
				8000
			);
			newId = '';
			newReason = '';
			newExpiry = '0';
			newCustom = '';
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function setMembersReserved(on: boolean) {
		busy = true;
		try {
			const res = await api<{ sync: ListSyncSummary }>(
				'PATCH',
				`/api/orgs/${encodeURIComponent(org.id)}`,
				{ membersReserved: on }
			);
			toast(
				describeSync(res.sync, on ? 'Members now get a reserved slot.' : 'Member slots withdrawn.'),
				'ok',
				8000
			);
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

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

	async function remove(e: ListEntryView, name: string | null) {
		const label = name ? `${name} (${e.steamId})` : e.steamId;
		if (
			!(await confirmDialog(
				group
					? `Take ${label} out of ${group.name}?`
					: `Withdraw the reserved slot for ${label} across ${org.name}?`,
				{ okLabel: group ? 'Remove' : 'Withdraw', danger: true }
			))
		)
			return;
		busy = true;
		try {
			const res = await api<{ sync: ListSyncSummary }>(
				'DELETE',
				`${path}/${encodeURIComponent(e.steamId)}`
			);
			toast(
				group
					? groupOff
						? `Took ${e.steamId} out of ${group.name}.`
						: describeSync(res.sync, `Took ${e.steamId} out of ${group.name}.`)
					: describeSync(res.sync, `Withdrew the slot for ${e.steamId}.`),
				'ok',
				8000
			);
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<ReserveTabs {org} {lists} current={group?.id ?? null} />
{#if group}<GroupBar {org} {group} servers={lists.servers} />{/if}

<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
	<div class="panel">
		<span class="label-sm">{group ? `In ${group.name}` : 'On the list'}</span>
		<div class="flex items-baseline gap-2">
			<span class="font-display text-[34px] leading-none font-semibold tabular"
				>{entries.length}</span
			>
			{#if playing}
				<span class="ml-auto inline-flex items-center gap-1.5 text-[12.5px] text-ok"
					><span class="size-1.5 rounded-full bg-ok"></span>{playing} playing now</span
				>
			{/if}
		</div>
		{#if group}
			<p class="note">
				While {group.name} is on, everyone here skips the join queue on {where}. Off, the group has
				no effect on any server.
			</p>
		{:else}
			<div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
				<span><b>{picked}</b> reserved by hand</span>
				{#if lists.membersReserved || members}<span><b>{members}</b> members</span>{/if}
			</div>
			<p class="note">
				Anyone on the list skips the join queue on every server in {org.name}. The list has no
				length limit; each server's MaxReservedSlots only sets how many player slots it holds back.
			</p>
		{/if}
	</div>

	<div class="panel">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<span class="label-sm mb-0!">{group ? 'On its servers' : 'On the servers'}</span>
			<button class="ml-auto btn btn-sm" disabled={busy || !lists.servers.length} onclick={syncNow}
				>Sync now</button
			>
		</div>
		{#each standing as s (s.id)}
			<div class="kv items-start py-1.5 text-[13px]">
				<div class="min-w-0">
					{#if s.href}
						<a href={s.href} class="font-medium hover:text-accent hover:underline">{s.name}</a>
					{:else}
						<span class="font-medium">{s.name}</span>
					{/if}
					<div class="text-[12px] text-mist-400">
						{#if s.syncedAt}synced {fmtTime(s.syncedAt)}{:else}never synced{/if}
						{#if s.lastError}<span class="text-danger"> · {s.lastError}</span>{/if}
					</div>
				</div>
				<span class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
					{#if groupOff}
						<span class="text-mist-400">group off</span>
					{:else}
						<span><b>{s.applied}</b> <span class="text-mist-400">of {entries.length}</span></span>
						{#if s.pending}<Badge tone="warn">{s.pending} pending</Badge>{/if}
					{/if}
				</span>
			</div>
		{:else}
			<p class="text-[13px] text-mist-400">
				{#if group}
					{group.name} is for no server. Choose its servers with Servers… above.
				{:else}
					{org.name} has no servers yet, so there is nothing to push the list to. Entries are kept and
					applied when a server is added.
				{/if}
			</p>
		{/each}
	</div>

	<div class="flex flex-col panel">
		<span class="label-sm">{group ? 'Add a player' : 'Reserve a slot everywhere'}</span>
		<form
			class="space-y-2"
			onsubmit={(e) => {
				e.preventDefault();
				void addReserved();
			}}
		>
			<div class="join join-wrap w-full">
				<input
					class="input font-mono"
					type="text"
					inputmode="numeric"
					placeholder="SteamID64…"
					maxlength="17"
					required
					bind:value={newId}
				/>
				<button type="submit" class="btn btn-primary" disabled={busy || !newId.trim()}
					>{group ? 'Add' : 'Reserve'}</button
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
				placeholder={group ? 'Note (optional)' : 'Note, e.g. donor, clan member (optional)'}
				bind:value={newReason}
			/>
			<div class="flex flex-wrap gap-2">
				<label class="block sm:w-40"
					><span class="field-label">Expires</span><select class="input" bind:value={newExpiry}>
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
			{#if group}
				While the group is on, a player added here gets the slot at once; while it is off, when it
				is next switched on. A player with an expiry leaves the group when the time comes.
			{:else}
				Handed out on every server in {org.name}, now and when one is added later. A slot with an
				expiry is withdrawn by the panel when the time comes. To reserve a slot on one server only,
				use that server's Reserved slots tab.
			{/if}
		</p>
		{#if owner && !group}
			<label class="mt-3 flex items-start gap-2 border-t border-white/8 pt-3 text-[13px]">
				<input
					type="checkbox"
					class="mt-0.5"
					checked={lists.membersReserved}
					disabled={busy}
					onchange={(e) => setMembersReserved((e.currentTarget as HTMLInputElement).checked)}
				/>
				<span
					><b>Members get a reserved slot.</b>
					<span class="block text-mist-400"
						>Every member of {org.name} who linked a SteamID on their Account page is reserved a slot
						on all its servers. Banned members are skipped.</span
					></span
				>
			</label>
		{/if}
	</div>
</div>

{#if owner && !group}<ImportCandidates kind="reserve" {org} {owner} />{/if}

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<span class="label-sm mb-0!">{group ? `Who is in ${group.name}` : 'Who holds a slot'}</span>
		<div class="flex w-full items-center gap-2 sm:ml-auto sm:w-auto sm:min-w-[320px]">
			<input
				class="input"
				type="search"
				placeholder="Filter by name, SteamID, note, admin…"
				bind:value={search}
			/>
			<span class="shrink-0 text-[12.5px] whitespace-nowrap text-mist-600"
				>{entries.length}
				{group ? 'player' : 'slot'}{entries.length === 1 ? '' : 's'}</span
			>
		</div>
	</div>
	{#if entries.length}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<SortHeader {sort} key="player">Player</SortHeader>
						<SortHeader {sort} key="steamId">SteamID64</SortHeader>
						{#if !group}<SortHeader {sort} key="source">Source</SortHeader>{/if}
						<SortHeader {sort} key="note">Note</SortHeader>
						<SortHeader {sort} key="added">Added</SortHeader>
						<SortHeader {sort} key="expires">Expires</SortHeader>
						<SortHeader {sort} key="servers">Servers</SortHeader>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.e.id)}
						{@const e = r.e}
						<tr class={e.expired ? 'text-mist-400' : ''}>
							<td>
								<span class="inline-flex min-w-0 items-center gap-2.5">
									<span
										class="size-2 shrink-0 rounded-full {r.live
											? 'bg-ok ring-[3px] ring-ok/25'
											: 'bg-ink-700'}"
										title={r.live
											? `Playing now on ${r.live.servers.join(', ')}`
											: 'Not on a server right now'}
									></span>
									{#if r.avatar}<img
											src={r.avatar}
											alt=""
											class="size-5 shrink-0 rounded-sm"
											loading="lazy"
											referrerpolicy="no-referrer"
										/>{/if}
									{#if dossierBase}
										<a
											href="{dossierBase}/{e.steamId}"
											data-sveltekit-preload-data="tap"
											class="truncate font-medium hover:text-accent hover:underline {r.name
												? ''
												: 'text-mist-400 italic'}"
											title="Open dossier">{r.name ?? 'Not seen yet'}</a
										>
									{:else}
										<span class="truncate font-medium {r.name ? '' : 'text-mist-400 italic'}"
											>{r.name ?? 'Not seen yet'}</span
										>
									{/if}
								</span>
								{#if r.live}<div class="mt-0.5 pl-[18px] caps text-[10px] text-ok">
										playing on {r.live.servers.join(', ')}
									</div>{/if}
							</td>
							<td class="font-mono text-[12.5px] text-mist-400">{e.steamId}</td>
							{#if !group}
								<td>
									{#if e.member}
										<Badge tone="accent">member</Badge>
									{:else}
										<Badge tone="ok">list</Badge>
									{/if}
								</td>
							{/if}
							<td class="max-w-[280px]">
								{#if e.reason}{e.reason}{:else}<span class="text-mist-600">—</span>{/if}
							</td>
							<td class="text-[12.5px] whitespace-nowrap">
								{#if e.member}
									<span class="text-mist-400">by membership</span>
								{:else}
									<div>{e.addedByName || '—'}</div>
									<div class="text-mist-400">{fmtTime(e.addedAt)}</div>
								{/if}
							</td>
							<td class="text-[12.5px] whitespace-nowrap">
								{#if !e.expiresAt}
									<span class="text-mist-600">never</span>
								{:else if e.expired}
									<Badge tone="warn">expired, withdrawing</Badge>
								{:else}
									{fmtTime(e.expiresAt)}
								{/if}
							</td>
							<td>
								{#if groupOff}
									<span class="text-[12.5px] text-mist-600">group off</span>
								{:else}
									<span class="inline-flex flex-wrap gap-1">
										{#each e.servers as s (s.serverId)}
											<span
												class="whitespace-nowrap"
												title="{s.serverName}: {STATE_TEXT[s.state]}{s.error
													? ` — ${s.error}`
													: ''}"
											>
												<Badge tone={STATE_TONE[s.state]}>{s.serverName}</Badge>
											</span>
										{/each}
									</span>
								{/if}
							</td>
							<td class="text-right whitespace-nowrap">
								{#if !e.member}
									<button
										type="button"
										class="btn btn-sm btn-ghost"
										title={group
											? `Take this player out of ${group.name}`
											: 'Withdraw this slot on every server'}
										disabled={busy}
										onclick={() => remove(e, r.name)}>{group ? 'Remove' : 'Withdraw'}</button
									>
								{/if}
							</td>
						</tr>
					{:else}
						<tr
							><td colspan={group ? 7 : 8} class="py-6 text-center text-mist-600"
								>Nobody matches that filter.</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
		{#if group}
			<p class="note">
				Server badges as on the organisation's list: <Badge tone="ok">applied</Badge> by the panel,
				<Badge tone="warn">pending</Badge> the next sync, <Badge tone="err">failed</Badge> (hover for
				why), <Badge>local</Badge> already on that server but added outside the panel.
			</p>
		{:else}
			<p class="note">
				<Badge tone="ok">list</Badge> slots were reserved here and can be withdrawn; <Badge
					tone="accent">member</Badge
				> slots follow membership and go when the member leaves or the switch above is turned off. Server
				badges: <Badge tone="ok">applied</Badge> by the panel, <Badge tone="warn">pending</Badge> the
				next sync, <Badge tone="err">failed</Badge> (hover for why), <Badge>local</Badge> already on that
				server but added outside the panel, so the panel never removes it.
			</p>
		{/if}
	{:else if group}
		<div class="callout mb-0">
			<b>Nobody is in {group.name} yet.</b>
			<span class="block text-mist-400"
				>Add players above. They skip the queue on {where} while the group is on.</span
			>
		</div>
	{:else}
		<div class="callout mb-0">
			<b>Nobody holds a reserved slot yet.</b>
			<span class="block text-mist-400"
				>A reserved slot lets your admins, donors and clan members skip the queue when a server is
				full. Reserve one above and the panel hands it out on every server in {org.name}.</span
			>
		</div>
	{/if}
</div>
