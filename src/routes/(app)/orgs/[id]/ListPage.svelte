<script lang="ts">
	// One org list (bans or reserved slots): its entries, where each stands on every server, and
	// the add / remove controls. Shared by the /bans and /reserved pages.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { describeSync, KIND_TITLE, STATE_TEXT, STATE_TONE } from '$lib/lists';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import type { ListEntryView, ListKind, ListSyncSummary, OrgListsView } from '$lib/types';

	let {
		kind,
		entries,
		lists,
		org
	}: {
		kind: ListKind;
		entries: ListEntryView[];
		lists: OrgListsView;
		org: { id: string; name: string };
	} = $props();

	let path = $derived(`/api/orgs/${encodeURIComponent(org.id)}/lists/${kind}/entries`);
	let search = $state('');
	let busy = $state(false);
	let banning = $state(false);
	// reserved-slot add form
	let newId = $state('');
	let newReason = $state('');
	let newPriority = $state(0);

	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return entries.filter(
			(e) =>
				!q ||
				e.steamId.includes(q) ||
				(e.name || '').toLowerCase().includes(q) ||
				e.reason.toLowerCase().includes(q) ||
				e.addedByName.toLowerCase().includes(q)
		);
	});
	let dossierBase = $derived(
		lists.servers.length ? `/server/${encodeURIComponent(lists.servers[0].id)}/players` : null
	);
	let noun = $derived(kind === 'ban' ? 'ban' : 'reserved slot');

	async function addReserved() {
		const steamId = newId.trim();
		if (!/^\d{17}$/.test(steamId)) {
			toast('Enter a 17-digit SteamID64.', 'err');
			return;
		}
		busy = true;
		try {
			const res = await api<{ sync: ListSyncSummary }>('POST', path, {
				steamId,
				reason: newReason.trim(),
				priority: newPriority
			});
			toast(describeSync(res.sync, `Reserved a slot for ${steamId}.`), 'ok', 8000);
			newId = '';
			newReason = '';
			newPriority = 0;
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
				kind === 'ban'
					? `Unban ${label} across ${org.name}? The panel lifts the ban on every server it applied it to.`
					: `Withdraw the reserved slot for ${label} across ${org.name}?`,
				{ okLabel: kind === 'ban' ? 'Unban' : 'Withdraw', danger: true }
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
				describeSync(
					res.sync,
					kind === 'ban' ? `Unbanned ${e.steamId}.` : `Withdrew the slot for ${e.steamId}.`
				),
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

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div>
		<h2 class="text-lg font-semibold tracking-tight">{KIND_TITLE[kind]}</h2>
		<p class="text-[13px] text-mist-400">
			{#if kind === 'ban'}
				Bans kept by the organisation and pushed to every one of its servers. Bans added on a server
				directly stay local to it.
			{:else}
				Reserved slots the organisation hands out on every one of its servers. Each server also has
				its own cap (MaxReservedSlots).
			{/if}
		</p>
	</div>
	{#if kind === 'ban'}
		<button class="ml-auto btn btn-primary" onclick={() => (banning = true)}>Add ban</button>
	{/if}
</div>

{#if kind === 'reserve'}
	<div class="mb-4 panel">
		<span class="label-sm">Reserve a slot</span>
		<form
			class="flex flex-wrap items-end gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				void addReserved();
			}}
		>
			<label class="block"
				><span class="field-label">SteamID64</span><input
					class="input font-mono sm:w-52"
					type="text"
					inputmode="numeric"
					maxlength="17"
					placeholder="7656119…"
					bind:value={newId}
					required
				/></label
			>
			<label class="block sm:flex-1"
				><span class="field-label">Note</span><input
					class="input"
					type="text"
					maxlength="200"
					placeholder="Optional, e.g. donor, clan member"
					bind:value={newReason}
				/></label
			>
			<label class="block sm:w-28"
				><span class="field-label">Priority</span><input
					class="input"
					type="number"
					min="-1000"
					max="1000"
					bind:value={newPriority}
				/></label
			>
			<button type="submit" class="btn btn-primary" disabled={busy}>Reserve</button>
		</form>
		<p class="note">Higher priority wins when a server's reserved slots are full.</p>
	</div>
{/if}

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
		>{entries.length} {noun}{entries.length === 1 ? '' : 's'}</span
	>
</div>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>Player</th>
				<th>{kind === 'ban' ? 'Reason' : 'Note'}</th>
				<th>By</th>
				<th>Added</th>
				{#if kind === 'ban'}<th>Expires</th>{:else}<th class="num">Priority</th>{/if}
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
						{#if e.member}<Badge tone="info" class="mt-1">member</Badge>{/if}
					</td>
					<td class="max-w-[280px]">
						{#if e.reason}{e.reason}{:else}<span class="text-mist-600">—</span>{/if}
					</td>
					<td>{e.addedByName || '—'}</td>
					<td class="text-[12.5px] whitespace-nowrap text-mist-400">{fmtTime(e.addedAt)}</td>
					{#if kind === 'ban'}
						<td class="text-[12.5px] whitespace-nowrap">
							{#if !e.expiresAt}
								<span class="text-mist-600">never</span>
							{:else if e.expired}
								<Badge tone="warn">expired, lifting</Badge>
							{:else}
								{fmtTime(e.expiresAt)}
							{/if}
						</td>
					{:else}
						<td class="num">{e.priority}</td>
					{/if}
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
						{#if !e.member}
							<button class="btn btn-sm btn-danger" disabled={busy} onclick={() => remove(e)}
								>{kind === 'ban' ? 'Unban' : 'Withdraw'}</button
							>
						{/if}
					</td>
				</tr>
			{:else}
				<tr
					><td colspan="7" class="py-6 text-center text-mist-600"
						>{entries.length ? 'Nothing matches the filter.' : `No ${noun}s yet.`}</td
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
