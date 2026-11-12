<script lang="ts">
	// Everyone this organisation has seen on the servers you can open: every name they used, when
	// and how much they played, and the ban, reserve and watch actions for someone who is not online.
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api, qs, errorMessage } from '$lib/api';
	import { can } from '$lib/capabilities';
	import { fmtDuration, fmtNum, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import type { SortLike } from '$lib/table.svelte';
	import type { SeenPlayer, SeenSort } from '$lib/server/seen';
	import { feedNamesLine } from '$lib/feed-names';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let orgId = $derived(data.org.id);
	/** each row action goes on one org list, and is offered to that list's editors */
	let canBan = $derived(data.listsRole.kinds.includes('ban'));
	let canReserve = $derived(data.listsRole.kinds.includes('reserve'));
	/**
	 * The watchlist is the organisation's, so Notes on any of its servers may mark a player: the
	 * mark goes through the player's last server where the caller keeps notes there, else through
	 * one where they do.
	 */
	let notesOn = $derived(
		data.orgServers.filter((s) => can(s.caps, 'players.notes')).map((s) => s.id)
	);
	const watchVia = (p: SeenPlayer): string | null =>
		notesOn.includes(p.lastServerId) ? p.lastServerId : (notesOn[0] ?? null);
	let apiBase = $derived(`/api/orgs/${encodeURIComponent(orgId)}/players`);

	let extra = $state<SeenPlayer[]>([]);
	let loadingMore = $state(false);
	$effect(() => {
		void data.players;
		extra = [];
	});
	let rows = $derived([...data.players, ...extra]);
	let more = $derived(rows.length < data.total);

	let f = $state({ q: '', server: '', since: '', flag: '' });
	$effect(() => {
		const d = data.filters;
		f = {
			q: d.q,
			server: d.serverId,
			since: d.since ? String(d.since) : '',
			flag: d.flag
		};
	});
	const query = (over: Partial<{ sort: SeenSort; dir: 'asc' | 'desc' }> = {}) => ({
		q: f.q.trim(),
		server: f.server,
		since: f.since,
		flag: f.flag,
		sort: over.sort ?? data.filters.sort,
		dir: over.dir ?? data.filters.dir
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	function apply(over: Partial<{ sort: SeenSort; dir: 'asc' | 'desc' }> = {}) {
		void goto(`${page.url.pathname}${qs(query(over))}`, {
			keepFocus: true,
			noScroll: true,
			replaceState: true
		});
	}
	function applyDebounced() {
		clearTimeout(timer);
		timer = setTimeout(() => apply(), 300);
	}
	/** the server does the ordering here: a header click becomes sort/dir params */
	const sort: SortLike<SeenSort> = {
		get key() {
			return data.filters.sort;
		},
		get dir() {
			return data.filters.dir;
		},
		toggle(key) {
			const same = data.filters.sort === key;
			const dir = same
				? data.filters.dir === 'asc'
					? 'desc'
					: 'asc'
				: key === 'name'
					? 'asc'
					: 'desc';
			apply({ sort: key, dir });
		}
	};

	async function loadMore() {
		if (loadingMore || !more) return;
		loadingMore = true;
		try {
			const d = await api<{ players: SeenPlayer[] }>(
				'GET',
				`${apiBase}${qs({ ...query(), offset: rows.length, limit: data.pageSize })}`
			);
			extra = [...extra, ...d.players];
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			loadingMore = false;
		}
	}

	// ---- row actions ----
	let banning = $state<SeenPlayer | null>(null);
	let busy = $state('');
	async function reserve(p: SeenPlayer) {
		if (
			!(await confirmDialog(
				`Reserve a slot for ${p.name} (${p.steamId}) on every server in ${data.org.name}?`,
				{
					okLabel: 'Reserve'
				}
			))
		)
			return;
		busy = p.steamId;
		try {
			await api('POST', `/api/orgs/${encodeURIComponent(orgId)}/lists/reserve/entries`, {
				steamId: p.steamId,
				reason: ''
			});
			toast(`${p.name} is on the organisation's reserved slots.`, 'ok');
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = '';
		}
	}
	async function watch(p: SeenPlayer) {
		const via = watchVia(p);
		if (!via) return;
		busy = p.steamId;
		try {
			await api('PUT', `/api/servers/${encodeURIComponent(via)}/players/${p.steamId}/watch`, {
				watched: !p.watched,
				reason: ''
			});
			toast(
				p.watched ? `${p.name} taken off the watchlist.` : `${p.name} is on the watchlist.`,
				'ok'
			);
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = '';
		}
	}
	const kd = (p: SeenPlayer) => (p.deaths ? (p.kills / p.deaths).toFixed(2) : p.kills ? '∞' : '—');
	const dossier = (p: SeenPlayer) =>
		`/server/${encodeURIComponent(p.lastServerId)}/players/${p.steamId}`;
</script>

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<span class="label-sm mb-0!">Players seen</span>
		<span class="text-[12.5px] text-mist-600"
			>{fmtNum(data.total)} on the servers you can open · names, playtime and stats stay inside {data
				.org.name}</span
		>
	</div>
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<input
			class="input w-full sm:w-72"
			type="search"
			placeholder="Name, alias or SteamID…"
			aria-label="Search players"
			bind:value={f.q}
			oninput={applyDebounced}
		/>
		<select
			class="input w-full sm:w-52"
			aria-label="Server"
			bind:value={f.server}
			onchange={() => apply()}
		>
			<option value="">Any server</option>
			{#each data.orgServers as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
		</select>
		<select
			class="input w-full sm:w-40"
			aria-label="Seen within"
			bind:value={f.since}
			onchange={() => apply()}
		>
			<option value="">Ever</option>
			<option value="1">Last day</option>
			<option value="7">Last 7 days</option>
			<option value="30">Last 30 days</option>
			<option value="90">Last 90 days</option>
		</select>
		<select
			class="input w-full sm:w-40"
			aria-label="Flag"
			bind:value={f.flag}
			onchange={() => apply()}
		>
			<option value="">Everyone</option>
			<option value="online">Online now</option>
			<option value="banned">Banned</option>
			<option value="watched">On watchlist</option>
		</select>
	</div>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<SortHeader {sort} key="name">Player</SortHeader>
					<SortHeader {sort} key="firstSeen">First seen</SortHeader>
					<SortHeader {sort} key="lastSeen">Last seen</SortHeader>
					<SortHeader {sort} key="sessions" num>Sessions</SortHeader>
					<SortHeader {sort} key="minutes" num>Playtime</SortHeader>
					<SortHeader {sort} key="kills" num>K</SortHeader>
					<SortHeader {sort} key="deaths" num>D</SortHeader>
					<th class="num">K/D</th>
					<th>Servers</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each rows as p (p.steamId)}
					<tr>
						<td class="max-w-[320px]">
							<div class="flex items-start gap-2.5">
								{#if p.steam?.avatar}<img
										src={p.steam.avatar}
										alt=""
										class="mt-0.5 size-6 shrink-0 rounded-sm"
										loading="lazy"
										referrerpolicy="no-referrer"
									/>{/if}
								<div class="min-w-0">
									<div class="flex flex-wrap items-center gap-1.5">
										<a
											href={dossier(p)}
											data-sveltekit-preload-data="tap"
											class="truncate font-medium hover:text-accent hover:underline"
											title="Open dossier">{p.name}</a
										>
										{#if p.online}<span class="size-1.5 rounded-full bg-ok" title="Online now"
											></span>{/if}
										{#if p.banned}<Badge tone="err"
												>{p.banned === 'org' ? 'banned' : 'banned here'}</Badge
											>{/if}
										{#if p.watched}<Badge tone="warn">watch</Badge>{/if}
									</div>
									{#if p.hiddenNames.length}
										{@const hid = feedNamesLine(p.hiddenNames, f.q)}
										<div
											class="truncate text-[12px] text-mist-400"
											title={p.hiddenNames.join(', ')}
										>
											in anonymous mode as {#each hid.names as h, i (h.name)}<span
													class={h.hit ? 'font-semibold text-accent' : ''}>{h.name}</span
												>{i < hid.names.length - 1
													? ', '
													: ''}{/each}{#if hid.more}{` and ${hid.more} more`}{/if}
										</div>
									{/if}
									{#if p.feedNames.length}
										{@const line = feedNamesLine(p.feedNames, f.q)}
										<div class="truncate text-[12px] text-mist-400" title={p.feedNames.join(', ')}>
											in the kill feed as {#each line.names as n, i (n.name)}<span
													class={n.hit ? 'font-semibold text-accent' : ''}>{n.name}</span
												>{i < line.names.length - 1
													? ', '
													: ''}{/each}{#if line.more}{` and ${line.more} more`}{/if}
										</div>
									{/if}
									{#if p.aliases.length}
										<div class="truncate text-[12px] text-mist-400" title={p.aliases.join(', ')}>
											also {p.aliases.slice(0, 4).join(', ')}{#if p.aliases.length > 4}
												and {p.aliases.length - 4} more{/if}
										</div>
									{/if}
									<div class="font-mono text-[11.5px] text-mist-600">
										{p.steamId}{#if p.steam?.persona && p.steam.persona !== p.name}
											· Steam: {p.steam.persona}{/if}
									</div>
								</div>
							</div>
						</td>
						<td class="whitespace-nowrap text-mist-400">{fmtTime(p.firstSeen)}</td>
						<td class="whitespace-nowrap">{fmtTime(p.lastSeen)}</td>
						<td class="num">{fmtNum(p.sessions)}</td>
						<td class="num whitespace-nowrap">{fmtDuration(p.minutes * 60)}</td>
						<td class="num">{fmtNum(p.kills)}</td>
						<td class="num">{fmtNum(p.deaths)}</td>
						<td class="num">{kd(p)}</td>
						<td class="whitespace-nowrap text-mist-400"
							>{p.servers > 1 ? `${p.servers} · last ` : ''}{p.lastServerName || '—'}</td
						>
						<td class="py-1.5 text-right whitespace-nowrap">
							<div class="inline-flex gap-1.5">
								{#if watchVia(p) || canReserve}
									<div class="join">
										{#if watchVia(p)}
											<button
												class="btn btn-sm"
												disabled={busy === p.steamId}
												onclick={() => watch(p)}>{p.watched ? 'Unwatch' : 'Watch'}</button
											>
										{/if}
										{#if canReserve}
											<button
												class="btn btn-sm"
												disabled={busy === p.steamId}
												onclick={() => reserve(p)}>Reserve</button
											>
										{/if}
									</div>
								{/if}
								{#if canBan}
									<button
										class="btn btn-sm btn-danger"
										disabled={busy === p.steamId || p.banned === 'org'}
										title={p.banned === 'org' ? 'Already on the organisation ban list' : ''}
										onclick={() => (banning = p)}>Ban</button
									>
								{/if}
							</div>
						</td>
					</tr>
				{:else}
					<tr
						><td colspan="10" class="py-6 text-center text-mist-600"
							>{data.filters.q || data.filters.serverId || data.filters.since || data.filters.flag
								? 'Nobody matches.'
								: 'Nobody has been seen yet. Rows appear as players join servers the worker watches.'}</td
						></tr
					>
				{/each}
			</tbody>
		</table>
	</div>
	<div class="mt-3 flex flex-wrap items-center gap-3">
		<span class="text-[12.5px] text-mist-600">{rows.length} of {fmtNum(data.total)}</span>
		{#if more}
			<button class="btn btn-sm" disabled={loadingMore} onclick={loadMore}
				>{loadingMore ? 'Loading…' : 'Load more'}</button
			>
		{/if}
	</div>
	<p class="note">
		Built from the sessions the worker records on servers you can open, so only players who have
		joined one of them appear, and only the names they used there. Playtime is the sum of session
		lengths.{#if canBan}
			Ban goes on the organisation's ban list.{/if}{#if canReserve}
			Reserve goes on its reserved slots.{/if}{#if notesOn.length}
			Watch marks the player across the organisation.{/if}
	</p>
</div>

{#if banning}
	{#key banning.steamId}
		<BanDialog
			{orgId}
			orgName={data.org.name}
			steamId={banning.steamId}
			name={banning.name}
			canOrg={canBan}
			reasons={data.lists.banReasons ?? []}
			onclose={() => (banning = null)}
			ondone={() => invalidateAll()}
		/>
	{/key}
{/if}
