<script lang="ts">
	import { api, qs } from '$lib/api';
	import { watchLive } from '$lib/live';
	import { can } from '$lib/capabilities';
	import OnlinePlayers, { type RosterServer } from '$lib/components/OnlinePlayers.svelte';
	import type { LiveView, Player, PlayerMark, ServerListsState, Status } from '$lib/types';
	import PastPlayers from './PastPlayers.svelte';
	import TeamsView from './TeamsView.svelte';
	import type { PageProps, Snapshot } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let canMove = $derived(can(data.server.caps, 'players.move') && !!data.features.changeTeam);
	let bans = $derived(can(data.server.caps, 'bans.manage'));
	let notes = $derived(can(data.server.caps, 'players.notes'));
	/** who is on now, the same players by side, or everyone who has played here */
	let view = $state<'online' | 'teams' | 'past'>('online');
	/** the Teams view stays mounted once opened, so its plan survives a look at the other views */
	let teamsOpened = $state(false);
	/** may the user write to the organisation's lists? Decides the ban dialog's default scope. */
	let listState = $state<ServerListsState | null>(null);

	let all = $state<Player[]>([]);
	let status = $state<Status | null>(null);
	let search = $state('');
	/** keep the filter across a trip to a dossier and back */
	export const snapshot: Snapshot<string> = {
		capture: () => search,
		restore: (v) => (search = v)
	};

	/** watchlist, first-visit and risk marks by SteamID; refreshed when the roster changes */
	let marks = $state<Record<string, PlayerMark>>({});
	let marksKey = '';
	let marksAt = 0;

	/** this server, as the online table lists it */
	let roster = $derived<RosterServer[]>([
		{
			id: data.server.id,
			name: data.server.name,
			orgId: data.server.orgId,
			orgName: data.server.orgName,
			manager: data.server.manager,
			caps: data.server.caps,
			canMove,
			scores: status?.scores,
			lists: listState,
			marks,
			players: all
		}
	]);

	function onLive(v: LiveView) {
		all = v.players;
		if (v.status) status = v.status;
		void refreshMarks(v.players);
	}
	/** After a command the worker looks again by itself; this only refreshes the panel's own marks. */
	async function refreshPlayers() {
		marksKey = '';
		await Promise.all([refreshMarks(all), refreshListState()]);
	}
	async function refreshMarks(players: Player[]) {
		const ids = players.map((p) => p.steamId).filter((s) => /^\d{17}$/.test(s));
		const key = ids.join(',');
		if (!ids.length) {
			marks = {};
			marksKey = '';
			return;
		}
		if (key === marksKey && Date.now() - marksAt < 30000) return;
		marksKey = key;
		marksAt = Date.now();
		try {
			const d = await api<{ marks: PlayerMark[] }>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/players/marks${qs({ ids: key, names: players.map((p) => p.name).join('\n') })}`
			);
			const next: Record<string, PlayerMark> = {};
			for (const m of d.marks) next[m.steamId] = m;
			marks = next;
		} catch (err) {
			console.warn('marks', err);
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
	$effect(() => {
		void id;
		void refreshListState();
		return watchLive([id], onLive);
	});
</script>

<div class="panel">
	<div class="join mb-3" role="tablist" aria-label="Which players">
		<button
			class="btn {view === 'online' ? 'btn-primary' : ''}"
			role="tab"
			aria-selected={view === 'online'}
			onclick={() => (view = 'online')}>Online now · {all.length}</button
		>
		<button
			class="btn {view === 'teams' ? 'btn-primary' : ''}"
			role="tab"
			aria-selected={view === 'teams'}
			onclick={() => {
				view = 'teams';
				teamsOpened = true;
			}}>Teams</button
		>
		<button
			class="btn {view === 'past' ? 'btn-primary' : ''}"
			role="tab"
			aria-selected={view === 'past'}
			onclick={() => (view = 'past')}>Past players</button
		>
	</div>
	{#if teamsOpened}
		{#key id}
			<div hidden={view !== 'teams'}>
				<TeamsView serverId={id} players={all} scores={status?.scores} {marks} {canMove} />
			</div>
		{/key}
	{/if}
	{#if view === 'past'}
		<PastPlayers
			server={{
				id,
				name: data.server.name,
				orgId: data.server.orgId,
				orgName: data.server.orgName
			}}
			canBan={bans}
			canWatch={notes}
			canOrg={listState?.canEditOrgBans ?? false}
			reasons={listState?.banReasons ?? []}
		/>
	{/if}
	<!-- Mounted all along, like Teams: its ticks, sort and dialogs survive a look at the other views. -->
	<div hidden={view !== 'online'}>
		<OnlinePlayers
			servers={roster}
			bind:search
			onrefresh={refreshPlayers}
			onacted={refreshPlayers}
		/>
		<p class="note">
			{#if listState?.canEditOrgBans || listState?.canEditOrgSlots}Everyone who has ever joined is
				under
				<a
					href="/orgs/{encodeURIComponent(data.server.orgId)}/players?server={encodeURIComponent(
						id
					)}"
					class="text-accent hover:underline">Players seen</a
				>, with the names they used.
			{/if}This server's ban list is under
			<a href="/server/{encodeURIComponent(id)}/bans" class="text-accent hover:underline">Bans</a>
			and its reserved slots under
			<a href="/server/{encodeURIComponent(id)}/slots" class="text-accent hover:underline"
				>Reserved slots</a
			>.
		</p>
	</div>
</div>
