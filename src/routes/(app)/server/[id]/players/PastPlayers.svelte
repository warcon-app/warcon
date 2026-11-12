<script lang="ts">
	// Everyone who has played on this server, from its own sessions: the Players tab's other view.
	// The server does the searching and the ordering; this holds the filters and the page of rows.
	import { untrack } from 'svelte';
	import { api, qs, errorMessage } from '$lib/api';
	import { fmtAgo, fmtDuration, fmtNum, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import type { SortLike } from '$lib/table.svelte';
	import type { SeenPlayer, SeenSort } from '$lib/server/seen';
	import type { BanReason } from '$lib/ban-reasons';
	import { feedNamesLine } from '$lib/feed-names';

	let {
		server,
		canBan,
		canWatch,
		canOrg,
		reasons
	}: {
		server: { id: string; name: string; orgId: string; orgName: string };
		/** holds Bans here: the row's Ban places it on this server's list or the org's */
		canBan: boolean;
		/** holds Notes here: the row's Watch puts the player on the org's watchlist */
		canWatch: boolean;
		/** may edit the org's ban list: the Ban dialog then offers every server */
		canOrg: boolean;
		/** the org's quick reasons for the Ban dialog */
		reasons: BanReason[];
	} = $props();

	const PAGE = 50;
	let q = $state('');
	let since = $state('1');
	let flag = $state('');
	let sortKey = $state<SeenSort>('lastSeen');
	let dir = $state<'asc' | 'desc'>('desc');
	let rows = $state<SeenPlayer[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let busy = $state('');
	let banning = $state<SeenPlayer | null>(null);

	let apiBase = $derived(`/api/servers/${encodeURIComponent(server.id)}/players/seen`);
	const query = () => ({ q: q.trim(), since, flag, sort: sortKey, dir });

	/** the newest request wins: a slow answer to an earlier search never lands over a later one */
	let asked = 0;
	async function load(offset = 0) {
		const mine = ++asked;
		loading = true;
		try {
			const d = await api<{ players: SeenPlayer[]; total: number }>(
				'GET',
				`${apiBase}${qs({ ...query(), offset, limit: PAGE })}`
			);
			if (mine !== asked) return;
			rows = offset ? [...rows, ...d.players] : d.players;
			total = d.total;
		} catch (err) {
			if (mine === asked) toast(errorMessage(err), 'err');
		} finally {
			if (mine === asked) loading = false;
		}
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const loadSoon = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void load(), 300);
	};
	// Only a change of server reloads here: load() reads the filters, and tracking them would send
	// a second request beside each filter's own and cancel the search box's pause.
	$effect(() => {
		void server.id;
		untrack(() => void load());
		return () => clearTimeout(timer);
	});

	const sort: SortLike<SeenSort> = {
		get key() {
			return sortKey;
		},
		get dir() {
			return dir;
		},
		toggle(key) {
			dir = sortKey === key ? (dir === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc';
			sortKey = key;
			void load();
		}
	};

	async function watch(p: SeenPlayer) {
		busy = p.steamId;
		try {
			await api('PUT', `/api/servers/${encodeURIComponent(server.id)}/players/${p.steamId}/watch`, {
				watched: !p.watched,
				reason: ''
			});
			toast(
				p.watched ? `${p.name} taken off the watchlist.` : `${p.name} is on the watchlist.`,
				'ok'
			);
			await load();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = '';
		}
	}
	const SINCE_LABEL: Record<string, string> = {
		'': 'ever',
		'1': 'in the last day',
		'7': 'in the last 7 days',
		'30': 'in the last 30 days',
		'90': 'in the last 90 days'
	};
</script>

<div class="mb-3 flex flex-wrap items-center gap-2">
	<input
		class="input w-full sm:w-80"
		type="search"
		placeholder="Name, alias or SteamID…"
		aria-label="Search past players"
		bind:value={q}
		oninput={loadSoon}
	/>
	<select
		class="input w-full sm:w-40"
		aria-label="Seen within"
		bind:value={since}
		onchange={() => load()}
	>
		<option value="1">Last day</option>
		<option value="7">Last 7 days</option>
		<option value="30">Last 30 days</option>
		<option value="90">Last 90 days</option>
		<option value="">Ever</option>
	</select>
	<select class="input w-full sm:w-40" aria-label="Flag" bind:value={flag} onchange={() => load()}>
		<option value="">Everyone</option>
		<option value="online">Online now</option>
		<option value="banned">Banned</option>
		<option value="watched">On watchlist</option>
	</select>
	<span class="text-[12.5px] text-mist-600 sm:ml-auto"
		>{#if loading && !rows.length}Searching…{:else}{fmtNum(rows.length)} of {fmtNum(total)} players seen
			here {SINCE_LABEL[since]}{/if}</span
	>
</div>
<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<SortHeader {sort} key="name">Player</SortHeader>
				<SortHeader {sort} key="lastSeen">Last seen</SortHeader>
				<SortHeader {sort} key="firstSeen">First seen</SortHeader>
				<SortHeader {sort} key="sessions" num>Sessions</SortHeader>
				<SortHeader {sort} key="minutes" num>Playtime</SortHeader>
				<SortHeader {sort} key="kills" num>K</SortHeader>
				<SortHeader {sort} key="deaths" num>D</SortHeader>
				<th></th>
				{#if canBan || canWatch}<th></th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each rows as p (p.steamId)}
				<tr>
					<td>
						<div class="flex flex-wrap items-baseline gap-x-2">
							<a
								href="/server/{encodeURIComponent(server.id)}/players/{p.steamId}"
								data-sveltekit-preload-data="tap"
								class="font-medium hover:text-accent hover:underline"
								title="Open profile">{p.name}</a
							>
							{#if p.aliases.length}
								<span class="text-[12px] text-mist-600" title={p.aliases.join(', ')}
									>also: {p.aliases.slice(0, 3).join(', ')}{#if p.aliases.length > 3}
										+{p.aliases.length - 3}{/if}</span
								>
							{/if}
						</div>
						{#if p.hiddenNames.length}
							{@const hid = feedNamesLine(p.hiddenNames, q)}
							<div class="text-[12px] text-mist-400" title={p.hiddenNames.join(', ')}>
								in anonymous mode as {#each hid.names as h, i (h.name)}<span
										class={h.hit ? 'font-semibold text-accent' : ''}>{h.name}</span
									>{i < hid.names.length - 1
										? ', '
										: ''}{/each}{#if hid.more}{` and ${hid.more} more`}{/if}
							</div>
						{/if}
						{#if p.feedNames.length}
							{@const line = feedNamesLine(p.feedNames, q)}
							<div class="text-[12px] text-mist-400" title={p.feedNames.join(', ')}>
								in the kill feed as {#each line.names as f, i (f.name)}<span
										class={f.hit ? 'font-semibold text-accent' : ''}>{f.name}</span
									>{i < line.names.length - 1
										? ', '
										: ''}{/each}{#if line.more}{` and ${line.more} more`}{/if}
							</div>
						{/if}
						<div class="font-mono text-[12.5px] text-mist-400">{p.steamId}</div>
					</td>
					<td class="whitespace-nowrap" title={fmtTime(p.lastSeen)}>{fmtAgo(p.lastSeen)}</td>
					<td class="whitespace-nowrap text-mist-400">{fmtTime(p.firstSeen)}</td>
					<td class="num">{fmtNum(p.sessions)}</td>
					<td class="num whitespace-nowrap">{fmtDuration(p.minutes * 60)}</td>
					<td class="num">{fmtNum(p.kills)}</td>
					<td class="num">{fmtNum(p.deaths)}</td>
					<td class="whitespace-nowrap">
						<span class="inline-flex gap-1">
							{#if p.online}<Badge tone="ok">online</Badge>{/if}
							{#if p.banned}<Badge tone="warn"
									>{p.banned === 'org' ? 'banned' : 'banned here'}</Badge
								>{/if}
							{#if p.watched}<Badge tone="info">watched</Badge>{/if}
						</span>
					</td>
					{#if canBan || canWatch}
						<td class="py-1.5 text-right whitespace-nowrap">
							<span class="inline-flex gap-1.5">
								{#if canWatch}
									<button class="btn btn-sm" disabled={busy === p.steamId} onclick={() => watch(p)}
										>{p.watched ? 'Unwatch' : 'Watch'}</button
									>
								{/if}
								{#if canBan}
									<button
										class="btn btn-sm btn-danger"
										disabled={!!p.banned}
										onclick={() => (banning = p)}>Ban</button
									>
								{/if}
							</span>
						</td>
					{/if}
				</tr>
			{:else}
				<tr
					><td colspan="9" class="py-6 text-center text-mist-600"
						>{loading ? 'Searching…' : 'Nobody matching has played here.'}</td
					></tr
				>
			{/each}
		</tbody>
	</table>
</div>
{#if rows.length < total}
	<div class="mt-3 text-center">
		<button class="btn btn-sm" disabled={loading} onclick={() => load(rows.length)}
			>Show more</button
		>
	</div>
{/if}
<p class="note">
	Everyone who has played on this server, from its own session history. A SteamID that never joined
	here cannot be found. Names open the player's profile{#if canBan}; Ban places the ban on this
		server's list, and it lands when they next join{/if}.
</p>

{#if banning}
	{#key banning.steamId}
		<BanDialog
			orgId={server.orgId}
			orgName={server.orgName}
			steamId={banning.steamId}
			name={banning.name}
			server={{ id: server.id, name: server.name }}
			{canOrg}
			{reasons}
			onclose={() => (banning = null)}
			ondone={() => load()}
		/>
	{/key}
{/if}
