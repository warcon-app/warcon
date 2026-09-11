<script lang="ts">
	import { rconGet, rconPost, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { watchLive } from '$lib/live';
	import {
		can,
		expSetLabel,
		fmtDuration,
		fmtNum,
		lightingLabel,
		mapLabel,
		zoneLabel
	} from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { setHealth } from '$lib/health.svelte';
	import MapPicker from '$lib/components/MapPicker.svelte';
	import MapArt from '$lib/components/MapArt.svelte';
	import FactionChip from '$lib/components/FactionChip.svelte';
	import CashChart from '$lib/components/CashChart.svelte';
	import { cashByFaction } from '$lib/cash';
	import { api } from '$lib/api';
	import { factionColor } from '$lib/format';
	import type { CashPoint } from '$lib/server/analytics';
	import type { LiveView, Player, Rotation, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let operator = $derived(can(data.server.role, 'operator'));

	let status = $state<Status | null>(null);
	let statusAt = $state(0);
	let rotation = $state<Rotation | null>(null);
	let players = $state<Player[]>([]);
	let live = $state<LiveView | null>(null);
	let playersSeenAt = '';
	let teamFilter = $state('');
	let now = $state(Date.now());
	let showPicker = $state(false);
	let broadcast = $state('');
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
			statusAt = v.statusAt ? Date.parse(v.statusAt) : Date.now();
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
		const stops = [watchLive([id], onLive), poll(refreshRotation, 30000)];
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => {
			stops.forEach((s) => s());
			clearInterval(t);
		};
	});

	let clock = $derived(
		status && status.matchSeconds !== null
			? fmtDuration(status.matchSeconds + (now - statusAt) / 1000)
			: '—'
	);
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
	let board = $derived(
		players
			.filter((p) => !teamFilter || (p.faction || 'unassigned') === teamFilter)
			.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
	);

	async function sendBroadcast() {
		const message = broadcast.trim();
		if (!message) return;
		if (await act('broadcast', { message })) broadcast = '';
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
					{@const pct = status.scoreCap
						? Math.min(100, Math.round((f.score / status.scoreCap) * 100))
						: 0}
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
			<div class="kv">
				<span class="text-mist-400">Server</span><span class="truncate"
					>{status.serverName || '—'}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Players</span><span
					>{fmtNum(status.playerCount)} / {fmtNum(status.maxPlayers)}</span
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
				<span class="text-mist-400">Score cap</span><span>{status.scoreCap ?? '—'}</span>
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
			<span class="text-mist-400">Match length</span><span
				class="font-mono text-2xl font-semibold tabular">{clock}</span
			>
		</div>
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
			<button class="btn" disabled={!operator} onclick={() => (showPicker = !showPicker)}
				>Override map</button
			>
			<button
				class="btn"
				disabled={!operator}
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
				disabled={!operator}
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
			{operator
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
			<span class="field-label">Announcement to all players</span>
			<div class="join w-full">
				<input
					class="input"
					type="text"
					maxlength="200"
					placeholder="Message shown to everyone on the server…"
					bind:value={broadcast}
					disabled={!operator}
				/>
				<button class="btn btn-primary" type="submit" disabled={!operator}>Send</button>
			</div>
		</form>
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
	<MapPicker bind:this={picker} serverId={id} catalog={data.catalog} disabled={!operator} />
	<div class="join join-stack mt-4">
		<button
			class="btn btn-primary"
			disabled={!operator || !data.features.rotationEdit}
			title={data.features.rotationEdit
				? ''
				: 'This server build serves no rotation edit routes, so a next map cannot be queued.'}
			onclick={() => picker && act('setNextMap', picker.selection(), { after: refreshStatus })}
			>Set as next map</button
		>
		<button
			class="btn btn-danger"
			disabled={!operator}
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
			<thead
				><tr
					><th>Player</th><th>Faction</th><th class="num">K</th><th class="num">D</th><th
						class="num">Cash</th
					><th class="num">Ping</th></tr
				></thead
			>
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
