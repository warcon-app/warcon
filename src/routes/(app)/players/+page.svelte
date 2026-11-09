<script lang="ts">
	// Everyone on now across the servers in view, one organisation at a time: the Players tab's
	// Online now table with a Server column. The page reads nothing of its own: the live stream of
	// the organisation's servers, and each server's marks and lists through the routes its Players
	// tab uses, so every row shows what the person may see on that server, and acts with what they
	// may do there.
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, qs } from '$lib/api';
	import { watchLive } from '$lib/live';
	import { can } from '$lib/capabilities';
	import { fmtNum } from '$lib/format';
	import AnnounceDialog from '$lib/components/AnnounceDialog.svelte';
	import OnlinePlayers, { type RosterServer } from '$lib/components/OnlinePlayers.svelte';
	import type { LiveView, PlayerMark, ServerListsState } from '$lib/types';
	import type { PageProps, Snapshot } from './$types';

	let { data }: PageProps = $props();

	/** the organisations in view, in the switcher's order; the page shows one at a time */
	let orgs = $derived.by(() => {
		const seen = new Map<string, string>();
		for (const s of data.servers) if (!seen.has(s.orgId)) seen.set(s.orgId, s.orgName);
		return [...seen].map(([id, name]) => ({ id, name }));
	});
	let org = $derived(
		orgs.find((o) => o.id === page.url.searchParams.get('org')) ??
			orgs.find((o) => o.id === data.user.defaultOrgId) ??
			orgs[0] ??
			null
	);
	let servers = $derived(data.servers.filter((s) => s.orgId === org?.id));
	function chooseOrg(id: string) {
		const url = new URL(page.url);
		url.searchParams.set('org', id);
		void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	let search = $state('');
	/** keep the filter across a trip to a dossier and back */
	export const snapshot: Snapshot<string> = {
		capture: () => search,
		restore: (v) => (search = v)
	};
	/** one server's players, or every server's (''); one of another organisation filters nothing */
	let only = $state('');
	let onlyHere = $derived(servers.some((s) => s.id === only) ? only : '');

	/** the worker's last look at each server, as it streams in */
	let live = $state<Record<string, LiveView>>({});
	/** watchlist, first-visit and risk marks, by server and SteamID */
	let marks = $state<Record<string, Record<string, PlayerMark>>>({});
	/** each server's bans and reserved slots, read once it has players */
	let lists = $state<Record<string, ServerListsState>>({});

	$effect(() => {
		const id = org?.id;
		const ids = servers.map((s) => s.id);
		if (!id || !ids.length) return;
		return watchLive(ids, onLive, undefined, undefined, { org: id, players: true });
	});

	function onLive(v: LiveView) {
		live[v.serverId] = v;
		if (!v.ok || !v.players.length) return;
		void readMarks(v.serverId, v);
		if (!listsAsked.has(v.serverId)) void readLists(v.serverId);
	}

	// Each server's marks and lists come from the routes its own Players tab reads, a few at a
	// time: a list read carries the server's whole ban list, and an organisation can have many.
	const AT_ONCE = 3;
	let running = 0;
	const waiting: (() => void)[] = [];
	async function inTurn<T>(fn: () => Promise<T>): Promise<T> {
		// a read that ends hands its place straight to the next one waiting
		if (running < AT_ONCE) running++;
		else await new Promise<void>((go) => waiting.push(go));
		try {
			return await fn();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else running--;
		}
	}

	/** Marks again when a server's roster changes, at most every 10 s; every 30 s while it does not. */
	const MARKS_GAP_MS = 10_000;
	const MARKS_FRESH_MS = 30_000;
	const marksRead = new Map<string, { key: string; at: number; busy: boolean; again?: boolean }>();
	async function readMarks(serverId: string, v: LiveView, force = false) {
		const players = v.players.filter((p) => /^\d{17}$/.test(p.steamId));
		const key = players.map((p) => p.steamId).join(',');
		const last = marksRead.get(serverId) ?? { key: '', at: 0, busy: false };
		const age = Date.now() - last.at;
		if (!key) return;
		// after an action, a read already under way is followed by another
		if (last.busy) {
			if (force) last.again = true;
			return;
		}
		if (!force && age < (key === last.key ? MARKS_FRESH_MS : MARKS_GAP_MS)) return;
		marksRead.set(serverId, { key, at: Date.now(), busy: true });
		try {
			const d = await inTurn(() =>
				api<{ marks: PlayerMark[] }>(
					'GET',
					`/api/servers/${encodeURIComponent(serverId)}/players/marks${qs({ ids: key, names: players.map((p) => p.name).join('\n') })}`
				)
			);
			marks[serverId] = Object.fromEntries(d.marks.map((m) => [m.steamId, m]));
		} catch (err) {
			console.warn('marks', err);
		} finally {
			const again = marksRead.get(serverId)?.again;
			marksRead.set(serverId, { key, at: Date.now(), busy: false });
			if (again && live[serverId]) void readMarks(serverId, live[serverId], true);
		}
	}
	/**
	 * Servers whose lists have been asked for: once each, as a server's own Players tab reads them,
	 * and again after an action or a Refresh. Never again for each observation while one waits.
	 */
	const listsAsked = new Set<string>();
	async function readLists(serverId: string) {
		listsAsked.add(serverId);
		try {
			lists[serverId] = await inTurn(() =>
				api<ServerListsState>('GET', `/api/servers/${encodeURIComponent(serverId)}/lists/state`)
			);
		} catch (err) {
			console.warn('list state', err);
		}
	}
	/** After a command the worker looks again by itself; this reads the panel's own marks again. */
	async function acted(serverId: string) {
		const v = live[serverId];
		await Promise.all([v ? readMarks(serverId, v, true) : null, readLists(serverId)]);
	}
	async function refresh() {
		const shown = onlyHere ? roster.filter((s) => s.id === onlyHere) : roster;
		await Promise.all(shown.filter((s) => s.players.length).map((s) => acted(s.id)));
	}

	/** the organisation's servers as the table lists them; a server whose last look failed has none */
	let roster = $derived<RosterServer[]>(
		servers.map((s) => {
			const v = live[s.id];
			return {
				id: s.id,
				name: s.name,
				orgId: s.orgId,
				orgName: s.orgName,
				manager: s.manager,
				caps: s.caps,
				canMove: can(s.caps, 'players.move'),
				scores: v?.status?.scores,
				lists: lists[s.id] ?? null,
				marks: marks[s.id] ?? {},
				players: v?.ok ? v.players : []
			};
		})
	);
	let playing = $derived(roster.reduce((n, s) => n + s.players.length, 0));
	let withPlayers = $derived(roster.filter((s) => s.players.length).length);
	let down = $derived(servers.filter((s) => live[s.id] && !live[s.id].ok));
	let checking = $derived(servers.length > 0 && servers.every((s) => !live[s.id]));

	let canAnnounce = $derived(servers.some((s) => can(s.caps, 'chat.send')));
	let announcing = $state(false);
</script>

<svelte:head><title>Players · {data.appName}</title></svelte:head>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div class="min-w-0">
		<h1 class="text-xl font-semibold tracking-tight">Players online</h1>
		{#if org && servers.length}
			<p class="text-[13px] text-mist-400">
				{#if checking}
					Checking {org.name}'s servers…
				{:else}
					{fmtNum(playing)} player{playing === 1 ? '' : 's'} on {withPlayers} of {servers.length} server{servers.length ===
					1
						? ''
						: 's'} of {org.name}{#if down.length}<span class="text-danger"
							>&nbsp;· not reachable: {down.map((s) => s.name).join(', ')}</span
						>{/if}
				{/if}
			</p>
		{/if}
	</div>
	<span class="ml-auto inline-flex flex-wrap gap-1.5">
		{#if orgs.length > 1}
			<select
				class="input w-auto pr-[30px] sm:max-w-56"
				aria-label="Organisation"
				value={org?.id}
				onchange={(e) => {
					only = '';
					chooseOrg(e.currentTarget.value);
				}}
			>
				{#each orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
			</select>
		{/if}
		{#if canAnnounce}
			<button class="btn" onclick={() => (announcing = true)}>Announce</button>
		{/if}
	</span>
</div>

{#if !servers.length}
	<div class="callout">
		{#if data.scope}
			No servers in {data.scope.name}{data.canManage ? ' yet' : ' are shared with you'}. Pick
			another organisation, or all of them, from the header.
		{:else}
			{data.canManage ? 'No servers yet.' : 'No servers have been shared with you yet.'}
		{/if}
	</div>
{:else}
	<div class="panel">
		{#key org?.id}
			<OnlinePlayers
				servers={roster}
				several
				only={onlyHere}
				bind:search
				onrefresh={refresh}
				onacted={acted}
			>
				{#snippet filters()}
					{#if servers.length > 1}
						<select
							class="input w-auto pr-[30px] sm:max-w-64"
							aria-label="Server"
							value={onlyHere}
							onchange={(e) => (only = e.currentTarget.value)}
						>
							<option value="">All servers</option>
							{#each roster as s (s.id)}<option value={s.id}>{s.name} · {s.players.length}</option
								>{/each}
						</select>
					{/if}
				{/snippet}
			</OnlinePlayers>
		{/key}
	</div>
{/if}

{#if announcing}
	<AnnounceDialog servers={data.servers} orgId={org?.id} onclose={() => (announcing = false)} />
{/if}
