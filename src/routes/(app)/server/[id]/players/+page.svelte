<script lang="ts">
	import { api, qs, rconPost, errorMessage } from '$lib/api';
	import { watchLive } from '$lib/live';
	import { fmtNum } from '$lib/format';
	import { can } from '$lib/capabilities';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import FactionChip from '$lib/components/FactionChip.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import type { LiveView, Player, PlayerMark, ServerListsState, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let moderate = $derived(can(data.server.caps, 'players.moderate'));
	let chat = $derived(can(data.server.caps, 'chat.send'));
	let bans = $derived(can(data.server.caps, 'bans.manage'));
	/** may the user write to the organisation's lists? Decides the ban dialog's default scope. */
	let listState = $state<ServerListsState | null>(null);
	let banning = $state<Player | null>(null);

	let all = $state<Player[]>([]);
	let status = $state<Status | null>(null);
	let search = $state('');
	let selected = $state<string | null>(null);
	let reason = $state('');
	let whisper = $state('');
	let team = $state('');
	/** watchlist, first-visit and risk marks by SteamID; refreshed when the roster changes */
	let marks = $state<Record<string, PlayerMark>>({});
	let marksKey = '';
	let marksAt = 0;
	let base = $derived(`/server/${encodeURIComponent(data.server.id)}/players`);

	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return all.filter((p) => !q || p.name.toLowerCase().includes(q) || p.steamId.includes(q));
	});
	let player = $derived(all.find((p) => p.steamId === selected) ?? null);

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
	function onLive(v: LiveView) {
		all = v.players;
		if (v.status) {
			status = v.status;
			if (!team && v.status.scores.length) team = v.status.scores[0].name;
		}
		void refreshMarks(v.players);
	}
	/** After a command the worker looks again by itself; this only refreshes the panel's own marks. */
	async function refreshPlayers() {
		marksKey = '';
		await refreshMarks(all);
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

	const withPlayer = (fn: (p: Player) => unknown) => () => {
		if (!player) {
			toast('Select a player first.', 'err');
			return;
		}
		return fn(player);
	};
</script>

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<div class="join w-full sm:w-auto sm:min-w-[320px]">
			<input
				class="input"
				type="search"
				placeholder="Filter by name or SteamID…"
				bind:value={search}
			/>
			<button class="btn" onclick={refreshPlayers}>Refresh</button>
		</div>
		<span class="ml-auto text-[12.5px] text-mist-600">{rows.length} / {all.length} players</span>
	</div>
	<div class="table-wrap">
		<table>
			<thead
				><tr
					><th>Player</th><th>Flags</th><th>Faction</th><th class="num">K</th><th class="num">D</th
					><th class="num">Cash</th><th class="num">Ping</th></tr
				></thead
			>
			<tbody>
				{#each rows as p (p.steamId)}
					{@const m = marks[p.steamId]}
					<tr
						class="clickable {selected === p.steamId ? 'selected' : ''}"
						onclick={() => (selected = selected === p.steamId ? null : p.steamId)}
					>
						<td
							><a
								href="{base}/{p.steamId}"
								class="hover:text-accent hover:underline"
								title="Open dossier"
								onclick={(e) => e.stopPropagation()}>{p.name}</a
							>
							<span class="font-mono text-[12px] text-mist-600">{p.steamId}</span></td
						>
						<td class="whitespace-nowrap">
							{#if m}
								{#if m.watched}<Badge tone="warn" class="mr-1">watch</Badge>{/if}
								{#if m.risk.level === 'high'}<Badge tone="err" class="mr-1"
										>risk {m.risk.score}</Badge
									>{:else if m.risk.level === 'medium'}<Badge tone="warn" class="mr-1"
										>risk {m.risk.score}</Badge
									>{/if}
								{#if m.firstVisit}<Badge tone="info">new</Badge>{/if}
							{/if}
						</td>
						<td><FactionChip faction={p.faction} scores={status?.scores} /></td>
						<td class="num">{p.kills}</td><td class="num">{p.deaths}</td>
						<td class="num">{fmtNum(p.cash)}</td><td class="num">{p.ping ?? '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="7" class="py-6 text-center text-mist-600">No players connected.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if player}
		<div
			class="mt-3 rise rounded-ctl border border-l-2 border-black border-l-accent bg-ink-950 p-3"
		>
			<div class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-0.5">
				<FactionChip faction={player.faction} scores={status?.scores} />
				<span class="min-w-0 truncate font-semibold">{player.name}</span>
				<span
					class="order-last basis-full font-mono text-[12px] text-mist-400 sm:order-none sm:basis-auto"
					>{player.steamId}</span
				>
				<a href="{base}/{player.steamId}" class="ml-auto btn btn-sm">Dossier</a>
				<button
					type="button"
					class="btn btn-sm btn-ghost"
					onclick={() => (selected = null)}
					aria-label="Deselect player">✕</button
				>
			</div>
			<div class="flex flex-wrap gap-x-5 gap-y-3">
				<div class="field-group sm:min-w-[340px] sm:flex-1">
					<span class="field-label">Discipline</span>
					<div class="join join-wrap w-full">
						<input
							class="input"
							type="text"
							placeholder="Reason (optional)…"
							maxlength="200"
							bind:value={reason}
						/>
						<button
							class="btn"
							disabled={!moderate}
							onclick={withPlayer((p) =>
								act('kill', { steamId: p.steamId }, { after: refreshPlayers })
							)}>Kill</button
						>
						<button
							class="btn btn-danger"
							disabled={!moderate}
							onclick={withPlayer((p) =>
								act(
									'kick',
									{ steamId: p.steamId, reason: reason.trim() },
									{ confirm: `Kick ${p.name}?`, danger: true, after: refreshPlayers }
								)
							)}>Kick</button
						>
						<button
							class="btn btn-danger"
							disabled={!bans}
							onclick={withPlayer((p) => (banning = p))}>Ban</button
						>
					</div>
				</div>
				{#if data.features.changeTeam}
					<div class="field-group">
						<span class="field-label">Team</span>
						<div class="join w-full">
							<select class="input sm:w-40 sm:flex-none" bind:value={team}>
								{#each status?.scores ?? [] as f (f.name)}<option value={f.name}>{f.name}</option
									>{/each}
							</select>
							<button
								class="btn"
								disabled={!moderate}
								onclick={withPlayer((p) =>
									act(
										'changeTeam',
										{ steamId: p.steamId, faction: team },
										{ after: refreshPlayers }
									)
								)}>Move</button
							>
						</div>
					</div>
				{/if}
				<div class="field-group sm:min-w-[300px] sm:flex-1">
					<span class="field-label">Whisper</span>
					<div class="join w-full">
						<input
							class="input"
							type="text"
							placeholder="Private message to {player.name}…"
							maxlength="200"
							bind:value={whisper}
						/>
						<button
							class="btn btn-primary"
							disabled={!chat}
							onclick={withPlayer(async (p) => {
								const message = whisper.trim();
								if (!message) return;
								if (await act('whisper', { steamId: p.steamId, message })) whisper = '';
							})}>Send</button
						>
					</div>
				</div>
			</div>
		</div>
	{/if}
	{#if !moderate && !chat}<p class="note">
			You have view-only access; player actions are disabled.
		</p>{/if}
	<p class="note">
		This server's ban list is under
		<a href="/server/{encodeURIComponent(id)}/bans" class="text-accent hover:underline">Bans</a>
		and its reserved slots under
		<a href="/server/{encodeURIComponent(id)}/slots" class="text-accent hover:underline"
			>Reserved slots</a
		>.
	</p>
</div>

{#if banning}
	{@const p = banning}
	<BanDialog
		orgId={data.server.orgId}
		orgName={data.server.orgName}
		steamId={p.steamId}
		name={p.name}
		server={{ id, name: data.server.name }}
		canOrg={listState?.canEditOrg ?? false}
		onclose={() => (banning = null)}
		ondone={refreshPlayers}
	/>
{/if}
