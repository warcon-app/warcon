<script lang="ts">
	import { scoreCapOf } from '$lib/match';
	import { currentState, stateLabel } from '$lib/match-state';
	import { feedHealth } from '$lib/feed-health';
	import { ApiError, rconGet, rconPost, errorMessage } from '$lib/api';
	import { MAX_CHAT } from '$lib/chat';
	import { poll } from '$lib/poll';
	import { watchLive, type KillsNotice } from '$lib/live';
	import { causeLabel } from '$lib/causes';
	import { expSetLabel, fmtAgo, fmtNum, lightingLabel, mapLabel, zoneLabel } from '$lib/format';
	import { can } from '$lib/capabilities';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { setHealth } from '$lib/health.svelte';
	import MapPicker from '$lib/components/MapPicker.svelte';
	import MapArt from '$lib/components/MapArt.svelte';
	import SavedMessages from '$lib/components/SavedMessages.svelte';
	import { sponsor, loadSponsor } from '$lib/sponsor.svelte';
	import FactionChip from '$lib/components/FactionChip.svelte';
	import CashChart from '$lib/components/CashChart.svelte';
	import { cashByFaction } from '$lib/cash';
	import { api } from '$lib/api';
	import { factionColor } from '$lib/format';
	import type { CashPoint } from '$lib/server/analytics';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { TableSort } from '$lib/table.svelte';
	import type { KillView, LiveView, Player, Rotation, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let chat = $derived(can(data.server.caps, 'chat.send'));
	// The banner the server advertises to the game's browser; the config page edits it.
	let banner = $derived(sponsor[data.server.id] ?? '');
	$effect(() => {
		void loadSponsor(data.server.id);
	});
	let match = $derived(can(data.server.caps, 'match.control'));

	let status = $state<Status | null>(null);
	let rotation = $state<Rotation | null>(null);
	let players = $state<Player[]>([]);
	let live = $state<LiveView | null>(null);
	let playersSeenAt = '';
	let teamFilter = $state('');
	let now = $state(Date.now());
	let showPicker = $state(false);
	let broadcast = $state('');
	/** who the message goes to: '' is everyone (a broadcast), else a faction (a whisper to each on it) */
	let to = $state('');
	let sending = $state(false);
	/** a faction whisper the game stopped early: who it did not reach, for Send again with the same text */
	let rest = $state<{ to: string; message: string; steamIds: string[] } | null>(null);
	let resend = $derived(rest && rest.to === to && rest.message === broadcast.trim() ? rest : null);
	let picker = $state<MapPicker>();
	let seeded = false;

	// Cash in play for the current match: one point per players poll, seeded from the poller's
	// samples since the match started so a page load does not begin with an empty chart. Cleared
	// when the map changes or the match clock jumps back (a restart).
	const CASH_POINTS_MAX = 1500;
	let cash = $state<CashPoint[]>([]);
	let cashView = $state<'chart' | 'table'>('chart');
	let cashSeeded = false;
	let prevMap: string | null = null;
	let prevMatchSeconds = Infinity;

	async function seedCash(matchSeconds: number) {
		cashSeeded = true;
		try {
			const since = new Date(Date.now() - matchSeconds * 1000).toISOString();
			const r = await api<{ points: CashPoint[] }>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/cash?since=${encodeURIComponent(since)}`
			);
			const firstLive = cash.length ? Date.parse(cash[0].ts) : Infinity;
			cash = [...r.points.filter((p) => Date.parse(p.ts) < firstLive), ...cash];
		} catch {
			/* the chart fills in from live polls */
		}
	}
	function noteCashStatus(s: Status) {
		const restarted =
			prevMap !== null && (s.map !== prevMap || (s.matchSeconds ?? 0) < prevMatchSeconds - 5);
		prevMap = s.map;
		prevMatchSeconds = s.matchSeconds ?? 0;
		if (restarted) {
			cash = [];
			cashSeeded = false;
		}
		if (!cashSeeded && s.matchSeconds !== null) void seedCash(s.matchSeconds);
	}
	function noteCashSample(list: Player[]) {
		const factions: Record<string, number> = {};
		let total = 0;
		for (const f of cashByFaction(status, list)) {
			factions[f.name] = f.cash;
			total += f.cash;
		}
		const next = [...cash, { ts: new Date().toISOString(), total, factions }];
		cash = next.length > CASH_POINTS_MAX ? next.slice(next.length - CASH_POINTS_MAX) : next;
	}

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

	// Status and players come from the worker's observations (an event stream, a few times a
	// second while this page is open); the rotation is read on load, after a command, and now and then.
	function onLive(v: LiveView) {
		live = v;
		setHealth(id, v.ok);
		if (v.status) {
			status = v.status;
			noteCashStatus(v.status);
			if (!seeded && picker) {
				seeded = true;
				void picker.setFrom({
					map: v.status.map,
					experiences: v.status.experiences,
					lighting: v.status.lighting,
					zoneAlternator: v.status.alternator
				});
			}
		}
		if (v.playersAt && v.playersAt !== playersSeenAt) {
			playersSeenAt = v.playersAt;
			players = v.players;
			noteCashSample(players);
		}
	}
	// The kill feed: the stored tail on load, then every batch as the game delivers it (the event
	// stream), with a slow re-read behind it in case a frame was missed.
	const KILLS_MAX = 100;
	let kills = $state<KillView[]>([]);
	let feedConfigured = $state<boolean | null>(null);
	let feedAt = $state<string | null>(null);
	async function loadKills() {
		try {
			const r = await api<{ configured: boolean; feedAt: string | null; kills: KillView[] }>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/kills?limit=${KILLS_MAX}`
			);
			feedConfigured = r.configured;
			feedAt = r.feedAt;
			kills = r.kills;
		} catch {
			/* the panel keeps what it has */
		}
	}
	function onKills(n: KillsNotice) {
		if (n.serverId !== id || !n.kills.length) return;
		const known = new Set(kills.map((k) => k.eventId));
		const fresh = n.kills.filter((k) => !known.has(k.eventId)).reverse();
		kills = [...fresh, ...kills].slice(0, KILLS_MAX);
		feedAt = n.kills[n.kills.length - 1].ts;
	}
	let feedAgeS = $derived(
		feedAt ? Math.max(0, Math.round((now - Date.parse(feedAt)) / 1000)) : null
	);
	// Nothing since the game started, a few minutes on: the feed does not reach the panel. Read from
	// the live view, without the token's time (that goes with the token, on the Config tab).
	let feedState = $derived(feedHealth({ configured: !!feedConfigured, feedAt, live }, now));
	/** changes at midnight only, so the rows' times are not worked out again every second */
	let today = $derived(new Date(now).toDateString());
	/** A kill's time, with its day when it is not today's: a silent feed leaves old kills on top. */
	const clock = (iso: string) => {
		const d = new Date(iso);
		const time = d.toLocaleTimeString(undefined, { hour12: false });
		return d.toDateString() === today
			? time
			: `${d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} ${time}`;
	};
	async function refreshRotation() {
		try {
			rotation = await rconGet<Rotation>(id, 'rotation');
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	/** After a command: the worker looks again on its own; the rotation is ours to re-read. */
	const refreshStatus = refreshRotation;

	$effect(() => {
		const stops = [
			watchLive([id], onLive, undefined, onKills),
			poll(refreshRotation, 30000),
			poll(loadKills, 60000)
		];
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => {
			stops.forEach((s) => s());
			clearInterval(t);
		};
	});

	let scoreScale = $derived(scoreCapOf(status));
	// Season 2 builds report the match's state on their feed; the status has none.
	let phase = $derived(currentState(live));
	let next = $derived(
		rotation && rotation.enabled && rotation.nextIndex >= 0
			? rotation.entries[rotation.nextIndex]
			: null
	);
	let teams = $derived.by(() => {
		const m = new Map<string, number>();
		for (const p of players) m.set(p.faction || '', (m.get(p.faction || '') || 0) + 1);
		return [...m.entries()];
	});
	/** the scoreboard's own order, kills then fewest deaths, is what a header sort layers on */
	const boardSort = new TableSort<Player>(
		{
			player: { by: (p) => p.name },
			faction: { by: (p) => p.faction },
			kills: { by: (p) => p.kills, dir: 'desc' },
			deaths: { by: (p) => p.deaths, dir: 'desc' },
			cash: { by: (p) => p.cash, dir: 'desc' },
			ping: { by: (p) => p.ping }
		},
		{ key: 'kills' }
	);
	let board = $derived(
		boardSort.sorted(
			players
				.filter((p) => !teamFilter || (p.faction || 'unassigned') === teamFilter)
				.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
		)
	);

	/** the factions of this match, and a chosen one that has since gone, so it is never swapped for everyone */
	let factions = $derived.by(() => {
		const names = (status?.scores ?? []).map((f) => f.name);
		return to && !names.includes(to) ? [...names, to] : names;
	});

	async function sendBroadcast() {
		const message = broadcast.trim();
		if (!message || sending) return;
		const again = resend;
		sending = true;
		try {
			if (!to) {
				if (await act('broadcast', { message })) broadcast = '';
				return;
			}
			const result = await rconPost<{ message: string; unsent: string[]; stopped?: string }>(
				id,
				'whisperMany',
				again ? { steamIds: again.steamIds, message } : { faction: to, message }
			);
			toast(result.message, result.stopped ? 'err' : 'ok');
			rest = result.stopped ? { to, message, steamIds: result.unsent } : null;
			if (!rest) broadcast = '';
		} catch (err) {
			toast(errorMessage(err), 'err');
			// Everyone it had not reached has left since: nobody is waiting for it any more.
			if (again && err instanceof ApiError && err.code === 'no_recipients') {
				rest = null;
				broadcast = '';
			}
		} finally {
			sending = false;
		}
	}
</script>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<div class="panel">
		<span class="label-sm">Scores</span>
		{#if status}
			<MapArt
				map={status.map}
				lighting={status.lighting}
				variant="wide"
				alt="{mapLabel(data.catalog, status.map)}, {lightingLabel(data.catalog, status.lighting)}"
				class="mb-3"
			/>
			<div class="mb-3 space-y-2.5">
				{#each status.scores as f (f.name)}
					{@const pct = Math.min(100, Math.max(0, Math.round((f.score / scoreScale) * 100)))}
					<div>
						<div class="mb-1 flex items-center justify-between text-[13px]">
							<span class="inline-flex items-center gap-1.5 font-medium"
								><span class="inline-block h-2.5 w-2.5 rounded-full" style="background:{f.colorHex}"
								></span>{f.name}</span
							>
							<span class="font-mono tabular">{fmtNum(f.score)}</span>
						</div>
						<div class="progress">
							<span class="progress-bar" style="width:{pct}%;background:{f.colorHex || ''}"></span>
						</div>
					</div>
				{/each}
			</div>
			{#if phase}
				<div class="kv">
					<span class="text-mist-400">Match</span><span
						>{stateLabel(phase.state)}<span class="text-mist-400"
							>&nbsp;· since {clock(phase.at)}</span
						></span
					>
				</div>
			{/if}
			<div class="kv">
				<span class="text-mist-400">Server</span><span class="truncate"
					>{status.serverName || '—'}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Players</span><span
					>{fmtNum(status.playerCount)} / {fmtNum(status.maxPlayers)}{#if live?.reservedSlots}<span
							class="text-mist-400">&nbsp;+ {live.reservedSlots} reserved</span
						>{/if}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Map</span><span>{mapLabel(data.catalog, status.map)}</span>
			</div>
			<div class="kv">
				<span class="text-mist-400">Game mode &amp; mods</span><span class="text-right"
					>{expSetLabel(data.catalog, status.experiences)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Time of day &amp; weather</span><span
					>{lightingLabel(data.catalog, status.lighting)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Control zone</span><span>{zoneLabel(status.alternator)}</span>
			</div>
			<div class="kv">
				<span class="text-mist-400">Score tick</span><span
					>{status.scoreTick !== null
						? `${status.scoreTick}s (range ${status.scoreTickMin}–${status.scoreTickMax})`
						: '—'}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Score cap</span><span
					>{scoreScale}{#if status.scoreCap === null}
						<span class="text-mist-600">(game default)</span>{/if}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Rotation</span>
				<span
					>{rotation
						? rotation.enabled
							? `${rotation.mode}, entry ${rotation.nowIndex + 1} now${rotation.nextIndex >= 0 ? `, ${rotation.nextIndex + 1} next` : ''} of ${rotation.entries.length}`
							: 'off'
						: '—'}</span
				>
			</div>
		{:else}
			<div class="text-mist-600">Loading…</div>
		{/if}
	</div>

	<div class="panel">
		<span class="label-sm">Match control</span>
		<div class="stat-big">
			<span class="text-mist-400">Next map</span>
			<span class="inline-flex items-center gap-3 text-right text-lg font-semibold"
				>{next
					? mapLabel(data.catalog, next.map)
					: rotation && !rotation.enabled && status
						? `${mapLabel(data.catalog, status.map)} again (rotation off)`
						: '—'}{#if next}<MapArt
						map={next.map}
						lighting={next.lighting}
						variant="720"
						alt=""
						class="w-16 shrink-0"
					/>{/if}</span
			>
		</div>
		{#if next && rotation}
			<p class="note mt-0">
				Rotation entry {rotation.nextIndex + 1} of {rotation.entries.length} · {expSetLabel(
					data.catalog,
					next.experiences
				)} · {lightingLabel(data.catalog, next.lighting)}
			</p>
		{/if}
		<div class="join join-stack mt-3">
			<button class="btn" disabled={!match} onclick={() => (showPicker = !showPicker)}
				>Override map</button
			>
			<button
				class="btn"
				disabled={!match}
				onclick={() =>
					act(
						'restartMatch',
						{},
						{
							confirm: 'Restart the current match? Scores reset; the rotation pointer stays put.',
							after: refreshStatus
						}
					)}>Restart match</button
			>
			<button
				class="btn btn-danger"
				disabled={!match}
				onclick={() =>
					act(
						'endMatch',
						{},
						{
							confirm:
								'Force end the match? The next map comes from the rotation (or the current map reloads if rotation is off).',
							danger: true,
							after: refreshStatus
						}
					)}>Force end match</button
			>
		</div>
		<p class="note">
			{chat || match
				? 'Both travel when the match-end screen finishes, not when the button is pressed.'
				: 'You have view-only access to this server.'}
		</p>
		<form
			class="mt-4"
			onsubmit={(e) => {
				e.preventDefault();
				void sendBroadcast();
			}}
		>
			<SavedMessages
				server={data.server}
				label="Message to"
				labelFor="broadcast-to"
				inputId="broadcast-text"
				value={broadcast}
				onpick={(text) => (broadcast = text)}
				enabled={chat}
			>
				<div class="join w-full">
					<select
						id="broadcast-to"
						class="input w-auto flex-none! pr-[30px]"
						bind:value={to}
						disabled={!chat}
					>
						<option value="">Everyone</option>
						{#each factions as f (f)}<option value={f}>{f}</option>{/each}
					</select>
					<input
						id="broadcast-text"
						class="input"
						type="text"
						maxlength={MAX_CHAT}
						aria-label="Message"
						placeholder={to
							? `Whispered to everyone on ${to}…`
							: 'Message shown to everyone on the server…'}
						bind:value={broadcast}
						disabled={!chat}
					/>
					<button class="btn btn-primary" type="submit" disabled={!chat || sending}
						>{resend ? `Send to the rest · ${resend.steamIds.length}` : 'Send'}</button
					>
				</div>
			</SavedMessages>
		</form>
		{#if banner}
			<div class="mt-4">
				<span class="field-label">Server image</span>
				{#key banner}
					<img
						src={banner}
						alt="Server banner"
						class="h-16 w-auto max-w-full rounded border border-black object-cover"
						loading="lazy"
						referrerpolicy="no-referrer"
						onerror={(e) => ((e.currentTarget as HTMLImageElement).hidden = true)}
					/>
				{/key}
			</div>
		{/if}
	</div>
</div>

<div class="mt-4 panel">
	<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
		<span class="label-sm mb-0">Cash in play</span>
		<span class="text-[12px] text-mist-600"
			>held by connected players this match · one point per observation</span
		>
		<span class="join ml-auto">
			<button
				class="btn btn-sm {cashView === 'chart' ? 'btn-primary' : ''}"
				onclick={() => (cashView = 'chart')}>Chart</button
			>
			<button
				class="btn btn-sm {cashView === 'table' ? 'btn-primary' : ''}"
				onclick={() => (cashView = 'table')}>Table</button
			>
		</span>
	</div>
	<CashChart
		points={cash}
		view={cashView}
		color={(name) => factionColor(name, status?.scores)}
		emptyText="No cash samples yet. Points appear as the scoreboard refreshes."
	/>
</div>

<div class="mt-4 panel" hidden={!showPicker}>
	<span class="label-sm">Map override</span>
	<MapPicker bind:this={picker} serverId={id} catalog={data.catalog} disabled={!match} />
	<div class="join join-stack mt-4">
		<button
			class="btn btn-primary"
			disabled={!match || !data.features.rotationEdit}
			title={data.features.rotationEdit
				? ''
				: 'This server build serves no rotation edit routes, so a next map cannot be queued.'}
			onclick={() => picker && act('setNextMap', picker.selection(), { after: refreshStatus })}
			>Set as next map</button
		>
		<button
			class="btn btn-danger"
			disabled={!match}
			onclick={() =>
				picker &&
				act('changeMap', picker.selection(), {
					confirm:
						'End the current round and travel to this selection when the match-end screen finishes?',
					danger: true,
					after: refreshStatus
				})}>Change map now</button
		>
	</div>
	<p class="note">
		Set as next map is a rotation edit: the selection moves into the slot the server plays next (and
		is added to the rotation if it is not there). Save rotation on the Map rotation tab makes that
		survive a restart.
	</p>
</div>

<div class="mt-4 panel">
	<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
		<span class="label-sm mb-0">Scoreboard</span>
		<div class="join">
			<button
				class="btn btn-sm {teamFilter === '' ? 'btn-primary' : ''}"
				onclick={() => (teamFilter = '')}>All {players.length}</button
			>
			{#each teams as [f, n] (f)}
				<button
					class="btn btn-sm {teamFilter === (f || 'unassigned') ? 'btn-primary' : ''}"
					onclick={() => (teamFilter = f || 'unassigned')}>{f || 'unassigned'} {n}</button
				>
			{/each}
		</div>
		<span class="ml-auto text-[12.5px] text-mist-600"
			>{players.length} on the server{#if live?.playersAt}
				· seen {Math.max(0, Math.round((now - Date.parse(live.playersAt)) / 1000))}s ago{/if}</span
		>
	</div>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<SortHeader sort={boardSort} key="player">Player</SortHeader>
					<SortHeader sort={boardSort} key="faction">Faction</SortHeader>
					<SortHeader sort={boardSort} key="kills" num>K</SortHeader>
					<SortHeader sort={boardSort} key="deaths" num>D</SortHeader>
					<SortHeader sort={boardSort} key="cash" num>Cash</SortHeader>
					<SortHeader sort={boardSort} key="ping" num>Ping</SortHeader>
				</tr>
			</thead>
			<tbody>
				{#each board as p (p.steamId)}
					<tr>
						<td>{p.name} <span class="font-mono text-[12px] text-mist-600">{p.steamId}</span></td>
						<td><FactionChip faction={p.faction} scores={status?.scores} /></td>
						<td class="num">{p.kills}</td><td class="num">{p.deaths}</td>
						<td class="num">{fmtNum(p.cash)}</td><td class="num">{p.ping ?? '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="6" class="py-6 text-center text-mist-600">No players connected.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

{#if feedConfigured || kills.length}
	<div class="mt-4 panel">
		<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
			<span class="label-sm mb-0">Kill feed</span>
			<span class="text-[12px] text-mist-600">from the game's own feed · newest first</span>
			<a
				href="/server/{encodeURIComponent(id)}/kills"
				class="text-[12.5px] text-accent hover:underline">All kills, with filters →</a
			>
			{#if feedState === 'silent' && live?.startedAt}
				<span class="ml-auto inline-flex flex-wrap items-center gap-2 text-[12.5px]">
					<span class="badge bg-warn/15 text-warn">silent</span>
					<span class="text-mist-400"
						>nothing since the server started {fmtAgo(live.startedAt, now)}</span
					>
					{#if can(data.server.caps, 'config.apply')}<a
							href="/server/{encodeURIComponent(id)}/config"
							class="text-accent hover:underline">Config →</a
						>{/if}
				</span>
			{:else}
				<span
					class="ml-auto text-[12.5px] {feedAgeS !== null && feedAgeS > 900 && players.length
						? 'text-warn'
						: 'text-mist-600'}"
				>
					{#if feedAgeS === null}no batch received yet{:else if feedAgeS > 900 && players.length}no
						events for {Math.round(feedAgeS / 60)} min with players on{:else}last event {feedAgeS}s
						ago{/if}
				</span>
			{/if}
		</div>
		<div class="max-h-[420px] table-wrap">
			<table>
				<thead>
					<tr
						><th>Time</th><th>Killer</th><th>Victim</th><th>Cause</th><th class="num">Distance</th
						><th></th></tr
					>
				</thead>
				<tbody>
					{#if feedState === 'silent' && live?.startedAt && kills.length}
						<tr
							><td colspan="6" class="text-center text-[12px] text-mist-400"
								>The server started at {clock(live.startedAt)} · nothing has come since</td
							></tr
						>
					{/if}
					{#each kills as k (k.eventId)}
						<tr class={k.teamKill ? 'text-warn' : ''}>
							<td class="font-mono text-[12px] whitespace-nowrap text-mist-400">{clock(k.ts)}</td>
							<td>
								{#if k.killer}
									<a
										href="/server/{encodeURIComponent(id)}/players/{k.killer.steamId}"
										data-sveltekit-preload-data="tap"
										class="hover:text-accent hover:underline">{k.killer.name}</a
									>
									{#if k.killer.faction}<FactionChip
											faction={k.killer.faction}
											scores={status?.scores}
										/>{/if}
								{:else}<span class="text-mist-600">—</span>{/if}
							</td>
							<td>
								<a
									href="/server/{encodeURIComponent(id)}/players/{k.victim.steamId}"
									data-sveltekit-preload-data="tap"
									class="hover:text-accent hover:underline">{k.victim.name}</a
								>
								{#if k.victim.faction}<FactionChip
										faction={k.victim.faction}
										scores={status?.scores}
									/>{/if}
							</td>
							<td class="text-mist-200"
								>{causeLabel(k.cause) || (k.tags.includes('Falling') ? 'Fall' : '—')}</td
							>
							<td class="num">{k.distanceM === null ? '—' : `${Math.round(k.distanceM)} m`}</td>
							<td class="whitespace-nowrap">
								{#if k.teamKill}<span class="chip">team kill</span>{/if}
								{#if k.suicide}<span class="chip">suicide</span>{/if}
								{#if k.headshot}<span class="chip">headshot</span>{/if}
								{#each k.tags as t (t)}<span class="chip"
										>{t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}</span
									>{/each}
							</td>
						</tr>
					{:else}
						<tr
							><td colspan="6" class="py-6 text-center text-mist-600"
								>No kills received yet. They appear here as the game posts them.</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/if}
