<script lang="ts">
	import { rconGet, rconPost, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { can, fmtNum } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import FactionChip from '$lib/components/FactionChip.svelte';
	import type { Ban, Player, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let operator = $derived(can(data.server.role, 'operator'));
	let admin = $derived(can(data.server.role, 'admin'));

	let all = $state<Player[]>([]);
	let status = $state<Status | null>(null);
	let bans = $state<Ban[]>([]);
	let reserved = $state<string[]>([]);
	let search = $state('');
	let banSearch = $state('');
	let selected = $state<string | null>(null);
	let selectedBan = $state<string | null>(null);
	let reason = $state('');
	let whisper = $state('');
	let team = $state('');
	let reservedId = $state('');

	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return all.filter((p) => !q || p.name.toLowerCase().includes(q) || p.steamId.includes(q));
	});
	let player = $derived(all.find((p) => p.steamId === selected) ?? null);
	let banRows = $derived.by(() => {
		const q = banSearch.trim().toLowerCase();
		return bans.filter(
			(b) =>
				!q ||
				b.steamId.includes(q) ||
				(b.bannedBy || '').toLowerCase().includes(q) ||
				(b.reason || '').toLowerCase().includes(q)
		);
	});

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
	async function refreshPlayers() {
		const [d, s] = await Promise.all([
			rconGet<{ players: Player[] }>(id, 'players'),
			status ? Promise.resolve(status) : rconGet<Status>(id, 'status')
		]);
		all = d.players;
		status = s;
		if (!team && s.scores.length) team = s.scores[0].name;
	}
	async function refreshReserved() {
		reserved = (await rconGet<{ reserved: string[] }>(id, 'reserved')).reserved;
	}
	async function refreshBans() {
		bans = (await rconGet<{ bans: Ban[] }>(id, 'bans')).bans;
	}
	const refreshAll = () => Promise.all([refreshPlayers(), refreshReserved(), refreshBans()]);

	$effect(() => {
		Promise.all([refreshReserved(), refreshBans()]).catch((err) => toast(errorMessage(err), 'err'));
		return poll(refreshPlayers, 3000);
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
		<input
			class="input max-w-xs"
			type="search"
			placeholder="Filter by name or SteamID…"
			bind:value={search}
		/>
		<button class="btn" onclick={refreshPlayers}>Refresh</button>
		<span class="ml-auto text-[12.5px] text-mist-600">{rows.length} / {all.length} players</span>
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
				{#each rows as p (p.steamId)}
					<tr
						class="clickable {selected === p.steamId ? 'selected' : ''}"
						onclick={() => (selected = selected === p.steamId ? null : p.steamId)}
					>
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
	{#if player}
		<div
			class="mt-3 flex rise flex-wrap items-center gap-2 rounded-ctl border border-l-2 border-black border-l-accent bg-ink-950 p-3"
		>
			<span class="mr-1 text-[13px] text-mist-400"
				>{player.name} · <span class="font-mono">{player.steamId}</span></span
			>
			<input
				class="input max-w-[220px]"
				type="text"
				placeholder="Reason…"
				maxlength="200"
				bind:value={reason}
			/>
			<button
				class="btn btn-danger"
				disabled={!operator}
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
				disabled={!admin}
				onclick={withPlayer((p) =>
					act(
						'ban',
						{ steamId: p.steamId, reason: reason.trim() },
						{
							confirm: `Ban ${p.name} (${p.steamId})? This persists in the server's config.`,
							danger: true,
							after: refreshAll
						}
					)
				)}>Ban</button
			>
			<button
				class="btn"
				disabled={!operator}
				onclick={withPlayer((p) => act('kill', { steamId: p.steamId }, { after: refreshPlayers }))}
				>Kill</button
			>
			{#if data.features.changeTeam}
				<select class="input max-w-[160px]" bind:value={team}>
					{#each status?.scores ?? [] as f (f.name)}<option value={f.name}>{f.name}</option>{/each}
				</select>
				<button
					class="btn"
					disabled={!operator}
					onclick={withPlayer((p) =>
						act('changeTeam', { steamId: p.steamId, faction: team }, { after: refreshPlayers })
					)}>Change team</button
				>
			{/if}
			<input
				class="input max-w-[220px]"
				type="text"
				placeholder="Whisper…"
				maxlength="200"
				bind:value={whisper}
			/>
			<button
				class="btn"
				disabled={!operator}
				onclick={withPlayer(async (p) => {
					const message = whisper.trim();
					if (!message) return;
					if (await act('whisper', { steamId: p.steamId, message })) whisper = '';
				})}>Whisper</button
			>
		</div>
	{/if}
	{#if !operator}<p class="note">You have view-only access; player actions are disabled.</p>{/if}
</div>

<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
	<div class="panel">
		<span class="label-sm">Reserved slots</span>
		<div class="mb-3 flex flex-wrap gap-1.5">
			{#each reserved as r (r)}
				<button
					type="button"
					class="chip cursor-pointer hover:bg-white/12"
					onclick={() => (reservedId = r)}>{r}</button
				>
			{:else}
				<span class="text-mist-600">None.</span>
			{/each}
		</div>
		<div class="flex gap-2">
			<input
				class="input font-mono"
				type="text"
				placeholder="SteamID64…"
				maxlength="17"
				bind:value={reservedId}
			/>
			<button
				class="btn"
				disabled={!admin}
				onclick={() =>
					act(
						'reservedAdd',
						{ steamId: reservedId.trim() },
						{
							after: async () => {
								reservedId = '';
								await refreshReserved();
							}
						}
					)}>Add</button
			>
			<button
				class="btn btn-danger"
				disabled={!admin}
				onclick={() =>
					act(
						'reservedRemove',
						{ steamId: reservedId.trim() },
						{
							after: async () => {
								reservedId = '';
								await refreshReserved();
							}
						}
					)}>Remove</button
			>
		</div>
		<p class="note">
			Click a slot to fill the field. Reserved slots are written to the server's ServerSettings.ini.
		</p>
	</div>
	<div class="panel lg:col-span-2">
		<span class="label-sm">Bans</span>
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<input
				class="input max-w-xs"
				type="search"
				placeholder="Filter bans by SteamID, admin, reason…"
				bind:value={banSearch}
			/>
			<button class="btn" onclick={refreshBans}>Refresh</button>
			<button
				class="btn btn-danger"
				disabled={!admin || !selectedBan}
				onclick={() =>
					selectedBan &&
					act(
						'unban',
						{ steamId: selectedBan },
						{
							confirm: `Unban ${selectedBan}?`,
							after: async () => {
								selectedBan = null;
								await refreshBans();
							}
						}
					)}>Unban selected</button
			>
		</div>
		<div class="table-wrap">
			<table>
				<thead><tr><th>SteamID64</th><th>Banned at (UTC)</th><th>By</th><th>Reason</th></tr></thead>
				<tbody>
					{#each banRows as b (b.steamId)}
						<tr
							class="clickable {selectedBan === b.steamId ? 'selected' : ''}"
							onclick={() => (selectedBan = selectedBan === b.steamId ? null : b.steamId)}
						>
							<td class="font-mono">{b.steamId}</td>
							<td class="font-mono text-[12px] text-mist-400">{b.bannedAtUtc || '—'}</td>
							<td>{b.bannedBy}</td>
							<td
								>{#if b.reason}{b.reason}{:else}<span class="text-mist-600">—</span>{/if}</td
							>
						</tr>
					{:else}
						<tr><td colspan="4" class="py-6 text-center text-mist-600">No bans.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
