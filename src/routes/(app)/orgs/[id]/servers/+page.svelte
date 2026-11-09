<script lang="ts">
	// The organisation's servers as this user may open them, with the worker's live view of each.
	// Adding, editing and sharing a server happens on the Servers page; this tab is where an org
	// owner sees them side by side.
	import { watchLive } from '$lib/live';
	import { fmtNum, mapName } from '$lib/format';
	import { can } from '$lib/capabilities';
	import AnnounceDialog from '$lib/components/AnnounceDialog.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Pulse from '$lib/components/Pulse.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { TableSort, matches } from '$lib/table.svelte';
	import type { LiveView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let owner = $derived(data.listsRole.owner);
	let live = $state<Record<string, LiveView>>({});
	$effect(() => {
		const ids = data.orgServers.map((s) => s.id);
		return watchLive(
			ids,
			(v) => {
				live[v.serverId] = v;
			},
			undefined,
			undefined,
			{ org: data.org.id }
		);
	});

	let q = $state('');
	type Row = (typeof data.orgServers)[number];
	const status = (s: Row) => (live[s.id]?.ok ? live[s.id].status : null);
	const sort = new TableSort<Row>({
		server: { by: (s) => s.name },
		target: { by: (s) => `${s.host}:${s.port}` },
		map: { by: (s) => (status(s) ? mapName(status(s)!.map) : null) },
		players: { by: (s) => status(s)?.playerCount, dir: 'desc' },
		access: { by: (s) => s.roleName }
	});
	let shown = $derived(
		sort.sorted(
			data.orgServers.filter((s) => {
				const st = live[s.id]?.status;
				return matches(
					q,
					s.name,
					`${s.host}:${s.port}`,
					s.notes,
					st?.serverName,
					st ? mapName(st.map) : null
				);
			})
		)
	);
	let seen = $derived(data.orgServers.filter((s) => live[s.id]));
	let reachable = $derived(seen.filter((s) => live[s.id].ok).length);
	let playing = $derived(
		seen.reduce((n, s) => n + (live[s.id].ok ? (live[s.id].status?.playerCount ?? 0) : 0), 0)
	);
	let canAnnounce = $derived(data.orgServers.some((s) => can(s.caps, 'chat.send')));
	let announcing = $state(false);
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div>
		<h2 class="text-lg font-semibold tracking-tight">
			Servers
			<span class="font-normal text-mist-600"
				>{data.orgServers.length} / {data.org.serverLimit}</span
			>
		</h2>
		<p class="text-[13px] text-mist-400">
			{#if !data.orgServers.length}
				Nothing here yet.
			{:else if seen.length}
				{reachable} of {data.orgServers.length} reachable, {fmtNum(playing)} playing now.
			{:else}
				Checking…
			{/if}
		</p>
	</div>
	{#if owner || canAnnounce}
		<span class="ml-auto inline-flex gap-1.5">
			{#if canAnnounce}
				<button class="btn" onclick={() => (announcing = true)}>Announce</button>
			{/if}
			{#if owner}<a class="btn btn-primary" href="/servers">Manage servers</a>{/if}
		</span>
	{/if}
</div>

{#if !data.orgServers.length}
	<div class="callout">
		{#if owner}
			No servers yet. <a href="/servers" class="font-semibold text-accent underline">Add one</a> on the
			Servers page; members with a default server role on their invite link only get access to servers
			that exist when they join.
		{:else}
			You do not have access to any of {data.org.name}'s servers.
		{/if}
	</div>
{:else}
	{#if data.orgServers.length > 5}
		<div class="mb-3">
			<input
				class="input sm:w-72"
				type="search"
				placeholder="Search name, host, map…"
				bind:value={q}
				aria-label="Search servers"
			/>
		</div>
	{/if}
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<SortHeader {sort} key="server">Server</SortHeader>
					<SortHeader {sort} key="target">Target</SortHeader>
					<SortHeader {sort} key="map">Map</SortHeader>
					<SortHeader {sort} key="players" num>Players</SortHeader>
					<SortHeader {sort} key="access">Your access</SortHeader>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each shown as s (s.id)}
					{@const v = live[s.id]}
					{@const st = v?.ok ? v.status : null}
					<tr>
						<td>
							<span class="inline-flex min-w-0 items-center gap-2">
								<Pulse ok={v ? v.ok : undefined} />
								<a
									href="/server/{encodeURIComponent(s.id)}"
									class="truncate font-medium text-accent hover:underline">{s.name}</a
								>
								{#if s.demo}<Badge tone="info">demo</Badge>{/if}
							</span>
							{#if st?.serverName && st.serverName !== s.name}
								<div class="truncate text-[12px] text-mist-400">{st.serverName}</div>
							{/if}
							{#if s.notes}<div class="text-[12px] text-mist-400">{s.notes}</div>{/if}
						</td>
						<td class="font-mono text-[12.5px] text-mist-400">{s.host}:{s.port}</td>
						<td>
							{#if st}
								{mapName(st.map)}
								{#if st.matchSeconds !== null}<div class="text-[12px] text-mist-400">
										{Math.floor(st.matchSeconds / 60)} min in
									</div>{/if}
							{:else if v}
								<span class="text-[12.5px] text-danger">{v.error || 'Unreachable.'}</span>
							{:else}
								<span class="text-mist-600">—</span>
							{/if}
						</td>
						<td class="num whitespace-nowrap">
							{#if st}
								<b>{fmtNum(st.playerCount)}</b>
								<span class="text-mist-400">/ {fmtNum(st.maxPlayers)}</span>{#if v.reservedSlots}
									<div class="text-[12px] text-mist-400">+ {v.reservedSlots} reserved</div>{/if}
							{:else}
								<span class="text-mist-600">—</span>
							{/if}
						</td>
						<td><RoleBadge role={s.roleName} /></td>
						<td class="text-right whitespace-nowrap">
							<span class="inline-flex gap-1.5">
								<a class="btn btn-sm" href="/server/{encodeURIComponent(s.id)}/players">Players</a>
								<a class="btn btn-sm" href="/server/{encodeURIComponent(s.id)}/slots"
									>Reserved slots</a
								>
							</span>
						</td>
					</tr>
				{:else}
					<tr><td colspan="6" class="py-8 text-center text-mist-600">No server matches.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

{#if announcing}
	<AnnounceDialog
		servers={data.orgServers}
		orgId={data.org.id}
		onclose={() => (announcing = false)}
	/>
{/if}
