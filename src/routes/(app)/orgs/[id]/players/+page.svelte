<script lang="ts">
	// Everyone this organisation has seen on the servers you can open: every name they used, when
	// and how much they played, and the ban, reserve and watch actions for someone who is not online.
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api, qs, errorMessage } from '$lib/api';
	import { fmtDuration, fmtNum, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { nextDir } from '$lib/sort';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import type { SeenPlayer, SeenSort } from '$lib/server/seen';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let orgId = $derived(data.org.id);
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
	function sortBy(sort: SeenSort) {
		// A name reads best A to Z, a count best from the top.
		const fallback = sort === 'name' ? 'asc' : 'desc';
		apply({ sort, dir: nextDir(data.filters.sort, data.filters.dir, sort, fallback) });
	}
	const sorted = (sort: SeenSort) => data.filters.sort === sort;

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
		busy = p.steamId;
		try {
			await api(
				'PUT',
				`/api/servers/${encodeURIComponent(p.lastServerId)}/players/${p.steamId}/watch`,
				{ watched: !p.watched, reason: '' }
			);
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
					<SortHeader
						label="Player"
						active={sorted('name')}
						dir={data.filters.dir}
						onsort={() => sortBy('name')}
					/>
					<SortHeader
						label="First seen"
						active={sorted('firstSeen')}
						dir={data.filters.dir}
						onsort={() => sortBy('firstSeen')}
					/>
					<SortHeader
						label="Last seen"
						active={sorted('lastSeen')}
						dir={data.filters.dir}
						onsort={() => sortBy('lastSeen')}
					/>
					<SortHeader
						label="Sessions"
						class="num"
						active={sorted('sessions')}
						dir={data.filters.dir}
						onsort={() => sortBy('sessions')}
					/>
					<SortHeader
						label="Playtime"
						class="num"
						active={sorted('minutes')}
						dir={data.filters.dir}
						onsort={() => sortBy('minutes')}
					/>
					<SortHeader
						label="K"
						class="num"
						active={sorted('kills')}
						dir={data.filters.dir}
						onsort={() => sortBy('kills')}
					/>
					<SortHeader
						label="D"
						class="num"
						active={sorted('deaths')}
						dir={data.filters.dir}
						onsort={() => sortBy('deaths')}
					/>
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
								<div class="join">
									<button class="btn btn-sm" disabled={busy === p.steamId} onclick={() => watch(p)}
										>{p.watched ? 'Unwatch' : 'Watch'}</button
									>
									<button
										class="btn btn-sm"
										disabled={busy === p.steamId}
										onclick={() => reserve(p)}>Reserve</button
									>
								</div>
								<button
									class="btn btn-sm btn-danger"
									disabled={busy === p.steamId || p.banned === 'org'}
									title={p.banned === 'org' ? 'Already on the organisation ban list' : ''}
									onclick={() => (banning = p)}>Ban</button
								>
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
		lengths. Ban goes on the organisation's ban list; Reserve on its reserved slots; Watch marks the
		player across the organisation.
	</p>
</div>

{#if banning}
	{#key banning.steamId}
		<BanDialog
			{orgId}
			orgName={data.org.name}
			steamId={banning.steamId}
			name={banning.name}
			canOrg={true}
			onclose={() => (banning = null)}
			ondone={() => invalidateAll()}
		/>
	{/key}
{/if}
