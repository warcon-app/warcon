<script lang="ts" module>
	import type { Capability } from '$lib/capabilities';
	import type { FactionScore, Player, PlayerMark, ServerListsState } from '$lib/types';

	/** A server whose players the table lists, with what the page holds of it. */
	export interface RosterServer {
		id: string;
		name: string;
		orgId: string;
		orgName: string;
		/** runs its organisation: the saved messages' Edit link */
		manager: boolean;
		caps: readonly Capability[];
		/** Move is offered: the capability, and a build that takes it */
		canMove: boolean;
		/** this match's sides: the faction colours, and where Move can send a player */
		scores: FactionScore[] | undefined;
		/** its bans and reserved slots (the Reserved column, the ban dialog); null until read */
		lists: ServerListsState | null;
		/** watchlist, first-visit and risk marks by SteamID */
		marks: Record<string, PlayerMark>;
		players: Player[];
	}
</script>

<script lang="ts">
	// Who is on now, as the Players tab lists them: one server's players, or (`several`) those of
	// several servers in one table with a Server column. Every row acts on its own server, with the
	// capabilities the person holds there; the page keeps the live view, the marks and the list
	// state, and is told after each action so it can read them again.
	import type { Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { rconPost, errorMessage } from '$lib/api';
	import { MAX_CHAT } from '$lib/chat';
	import { can } from '$lib/capabilities';
	import { fmtNum, steamNameBeside } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { STATE_TONE } from '$lib/lists';
	import { TableSort, matches } from '$lib/table.svelte';
	import Badge from './Badge.svelte';
	import BanDialog from './BanDialog.svelte';
	import FactionChip from './FactionChip.svelte';
	import Modal from './Modal.svelte';
	import SavedMessages from './SavedMessages.svelte';
	import SortHeader from './SortHeader.svelte';

	let {
		servers,
		several = false,
		search = $bindable(''),
		only = '',
		onrefresh,
		onacted,
		filters
	}: {
		servers: RosterServer[];
		/** a Server column, and the server's name beside a player wherever it would be ambiguous */
		several?: boolean;
		/** the filter box: the page keeps it, so it survives a trip to a dossier and back */
		search?: string;
		/** show one server's players alone (a filter like the box: whoever is ticked stays ticked) */
		only?: string;
		/** the Refresh button: read the marks and lists again */
		onrefresh: () => unknown;
		/** after an action on a server: read again what the page holds of it */
		onacted: (serverId: string) => unknown;
		/** more controls for the toolbar, after the filter box */
		filters?: Snippet;
	} = $props();

	interface Row {
		key: string;
		p: Player;
		s: RosterServer;
	}
	const keyOf = (serverId: string, steamId: string) => `${serverId}/${steamId}`;

	const chatOn = (s: RosterServer) => can(s.caps, 'chat.send');
	const kickOn = (s: RosterServer) => can(s.caps, 'players.kick');
	const killOn = (s: RosterServer) => can(s.caps, 'players.kill');
	const bansOn = (s: RosterServer) => can(s.caps, 'bans.manage');
	const actsOn = (s: RosterServer) => chatOn(s) || kickOn(s) || killOn(s) || s.canMove || bansOn(s);
	/** columns: tick boxes where any server takes a whisper, actions where any takes one */
	let chatAny = $derived(servers.some(chatOn));
	let actionsAny = $derived(servers.some(actsOn));

	/** every player on, server by server in the page's order, each in the worker's order */
	let all = $derived(
		servers.flatMap((s) => s.players.map((p): Row => ({ key: keyOf(s.id, p.steamId), p, s })))
	);

	/** the roster in that order until a header is clicked */
	const sort = new TableSort<Row>({
		player: { by: (r) => r.p.name },
		server: { by: (r) => r.s.name },
		flags: {
			by: (r) => {
				const m = r.s.marks[r.p.steamId];
				return m ? (m.watched ? 1000 : 0) + m.risk.score + (m.firstVisit ? 1 : 0) : 0;
			},
			dir: 'desc'
		},
		reserved: { by: (r) => !!r.s.lists?.reserved[r.p.steamId], dir: 'desc' },
		faction: { by: (r) => r.p.faction },
		kills: { by: (r) => r.p.kills, dir: 'desc' },
		deaths: { by: (r) => r.p.deaths, dir: 'desc' },
		cash: { by: (r) => r.p.cash, dir: 'desc' },
		ping: { by: (r) => r.p.ping }
	});
	let rows = $derived(
		sort.sorted(
			all.filter(
				(r) =>
					(!only || r.s.id === only) &&
					matches(
						search,
						r.p.name,
						r.p.steamId,
						r.s.marks[r.p.steamId]?.steamName,
						several ? r.s.name : null
					)
			)
		)
	);

	type Kind = 'whisper' | 'kick' | 'move';
	/** the one-field dialog an inline action opened; the row is a snapshot taken when it opened */
	let dialog = $state<{ kind: Kind; row: Row } | null>(null);
	let text = $state('');
	let team = $state('');
	let busy = $state(false);
	/** the dialog's player as the roster sees them now; null once they have left */
	let live = $derived.by(() => {
		const d = dialog;
		return d ? (all.find((r) => r.key === d.row.key)?.p ?? null) : null;
	});
	/** the dialog's server as the page holds it now (its sides may have changed) */
	let dialogServer = $derived.by(() => {
		const d = dialog;
		return d ? (servers.find((s) => s.id === d.row.s.id) ?? d.row.s) : null;
	});
	/** factions the dialog's player could be moved to */
	let destinations = $derived(
		(dialogServer?.scores ?? [])
			.map((f) => f.name)
			.filter((n) => n !== (live ?? dialog?.row.p)?.faction)
	);

	/** players ticked for a group whisper, by server and SteamID, and whether its dialog is open */
	const picked = new SvelteSet<string>();
	let grouping = $state(false);
	/** the ticked players still on, shown or filtered out */
	let pickedOn = $derived(all.filter((r) => picked.has(r.key)));
	/** the rows shown that can be ticked: those on a server that takes a whisper */
	let pickable = $derived(rows.filter((r) => chatOn(r.s)));
	let shownPicked = $derived(pickable.length > 0 && pickable.every((r) => picked.has(r.key)));
	/** the group whisper's saved messages are the organisation's, read through a server it chats on */
	let groupVia = $derived(pickedOn[0]?.s ?? servers.find(chatOn));
	let banning = $state<Row | null>(null);

	async function act(s: RosterServer, action: string, params: object) {
		try {
			const result = await rconPost<{ message?: string }>(s.id, action, params);
			toast(result?.message || `${action} done.`, 'ok');
			await onacted(s.id);
			return true;
		} catch (err) {
			toast(errorMessage(err), 'err');
			return false;
		}
	}

	function pick(key: string) {
		if (picked.has(key)) picked.delete(key);
		else picked.add(key);
	}
	/** ticks every row the filter shows, or clears them when all are ticked already */
	function pickShown() {
		const clear = shownPicked;
		for (const r of pickable) {
			if (clear) picked.delete(r.key);
			else picked.add(r.key);
		}
	}
	function openGroup() {
		if (busy || !pickedOn.length) return;
		text = '';
		grouping = true;
	}
	/**
	 * Whispers the ticked players, server by server (the game whispers one at a time, on each
	 * server's own budget); those a server did not reach stay ticked, so Send again goes to them alone.
	 */
	async function sendGroup() {
		const message = text.trim();
		if (busy || !pickedOn.length || !message) return;
		const groups = new Map<string, { s: RosterServer; steamIds: string[] }>();
		for (const r of pickedOn) {
			const g = groups.get(r.s.id) ?? { s: r.s, steamIds: [] };
			g.steamIds.push(r.p.steamId);
			groups.set(r.s.id, g);
		}
		busy = true;
		let done = true;
		try {
			for (const { s, steamIds } of groups.values()) {
				const said = (line: string) => (several ? `${s.name}: ${line}` : line);
				try {
					const result = await rconPost<{ message: string; unsent: string[]; stopped?: string }>(
						s.id,
						'whisperMany',
						{ steamIds, message }
					);
					toast(said(result.message), result.stopped ? 'err' : 'ok');
					for (const id of steamIds) picked.delete(keyOf(s.id, id));
					for (const id of result.unsent) picked.add(keyOf(s.id, id));
					if (result.stopped) done = false;
				} catch (err) {
					toast(said(errorMessage(err)), 'err');
					done = false;
				}
			}
			// whoever left while ticked is not waiting for it any more
			const on = new Set(all.map((r) => r.key));
			for (const key of [...picked]) if (!on.has(key)) picked.delete(key);
			if (done) grouping = false;
		} finally {
			busy = false;
		}
	}

	function open(kind: Kind, row: Row) {
		if (busy) return;
		text = '';
		dialog = { kind, row };
		team = destinations[0] ?? '';
	}
	async function kill(r: Row) {
		if (busy) return;
		if (
			!(await confirmDialog(`Kill ${r.p.name}?`, {
				title: `Kill ${r.p.name}`,
				okLabel: 'Kill',
				danger: true
			}))
		)
			return;
		busy = true;
		try {
			await act(r.s, 'kill', { steamId: r.p.steamId });
		} finally {
			busy = false;
		}
	}
	/** Submits the open dialog: whisper, kick with reason, or move to the chosen faction. */
	async function submit() {
		const d = dialog;
		if (!d || busy || !live) return;
		const { p, s } = d.row;
		let ok = false;
		busy = true;
		try {
			if (d.kind === 'whisper') {
				const message = text.trim();
				if (!message) return;
				ok = await act(s, 'whisper', { steamId: p.steamId, message });
			} else if (d.kind === 'kick') {
				ok = await act(s, 'kick', { steamId: p.steamId, reason: text.trim() });
			} else {
				if (!destinations.includes(team)) return;
				ok = await act(s, 'changeTeam', { steamId: p.steamId, faction: team });
			}
		} finally {
			busy = false;
		}
		// Only close the dialog the request came from, not one opened since.
		if (ok && dialog === d) dialog = null;
	}
	const TITLES: Record<Kind, string> = { whisper: 'Whisper to', kick: 'Kick', move: 'Move' };
	const SUBMIT: Record<Kind, string> = { whisper: 'Send', kick: 'Kick', move: 'Move' };
</script>

<div class="mb-3 flex flex-wrap items-center gap-2">
	<div class="join w-full sm:w-auto sm:min-w-[320px]">
		<input
			class="input"
			type="search"
			placeholder={several ? 'Filter by name, SteamID or server…' : 'Filter by name or SteamID…'}
			aria-label="Filter players"
			bind:value={search}
		/>
		<button class="btn" onclick={onrefresh}>Refresh</button>
	</div>
	{@render filters?.()}
	{#if chatAny}
		<button class="btn" disabled={busy || !pickedOn.length} onclick={openGroup}
			>Whisper selected{pickedOn.length ? ` · ${pickedOn.length}` : ''}</button
		>
	{/if}
	<span class="ml-auto text-[12.5px] text-mist-600">{rows.length} / {all.length} players</span>
</div>
<div class="table-wrap">
	<table>
		<thead>
			<tr>
				{#if chatAny}<th class="w-0"
						><input
							type="checkbox"
							aria-label="Select every player shown"
							checked={shownPicked}
							disabled={!pickable.length}
							onchange={pickShown}
						/></th
					>{/if}
				<SortHeader {sort} key="player">Player</SortHeader>
				{#if several}<SortHeader {sort} key="server">Server</SortHeader>{/if}
				<SortHeader {sort} key="flags">Flags</SortHeader>
				<SortHeader {sort} key="reserved">Reserved</SortHeader>
				<SortHeader {sort} key="faction">Faction</SortHeader>
				<SortHeader {sort} key="kills" num>K</SortHeader>
				<SortHeader {sort} key="deaths" num>D</SortHeader>
				<SortHeader {sort} key="cash" num>Cash</SortHeader>
				<SortHeader {sort} key="ping" num>Ping</SortHeader>
				{#if actionsAny}<th class="text-right">Actions</th>{/if}
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row.key)}
				{@const { p, s } = row}
				{@const m = s.marks[p.steamId]}
				{@const r = s.lists?.reserved[p.steamId]}
				{@const steam = steamNameBeside(p.name, m?.steamName)}
				{@const chat = chatOn(s)}
				<tr class={picked.has(row.key) ? 'selected' : ''}>
					{#if chatAny}<td class="w-0"
							>{#if chat}<input
									type="checkbox"
									aria-label="Select {p.name}"
									checked={picked.has(row.key)}
									onchange={() => pick(row.key)}
								/>{/if}</td
						>{/if}
					<td
						><a
							href="/server/{encodeURIComponent(s.id)}/players/{p.steamId}"
							data-sveltekit-preload-data="tap"
							class="font-medium text-mist-100 underline decoration-mist-600 underline-offset-[3px] hover:text-accent hover:decoration-accent"
							>{p.name}</a
						>
						<span class="font-mono text-[12px] text-mist-600">{p.steamId}</span>
						{#if steam}<span class="block text-[12.5px] text-mist-400"
								>Steam · <span class="text-mist-100">{steam}</span></span
							>{/if}</td
					>
					{#if several}<td class="whitespace-nowrap"
							><a
								href="/server/{encodeURIComponent(s.id)}/players"
								class="text-mist-100 hover:text-accent">{s.name}</a
							></td
						>{/if}
					<td class="whitespace-nowrap">
						{#if m}
							{#if m.watched}<Badge tone="warn" class="mr-1">watch</Badge>{/if}
							{#if m.risk.level === 'high'}<Badge tone="err" class="mr-1">risk {m.risk.score}</Badge
								>{:else if m.risk.level === 'medium'}<Badge tone="warn" class="mr-1"
									>risk {m.risk.score}</Badge
								>{/if}
							{#if m.firstVisit}<Badge tone="info">new</Badge>{/if}
						{/if}
					</td>
					<td class="whitespace-nowrap">
						{#if r}
							{#if r.member}
								<Badge tone="accent">member</Badge>
							{:else if r.managed}
								<Badge tone={STATE_TONE[r.state]}
									>{r.scope === 'server' ? 'here' : 'org'}{r.state === 'applied'
										? ''
										: ` · ${r.state}`}</Badge
								>
							{:else}
								<Badge>local</Badge>
							{/if}
						{/if}
					</td>
					<td><FactionChip faction={p.faction} scores={s.scores} /></td>
					<td class="num">{p.kills}</td><td class="num">{p.deaths}</td>
					<td class="num">{fmtNum(p.cash)}</td><td class="num">{p.ping ?? '—'}</td>
					{#if actionsAny}
						<td class="py-1.5 text-right whitespace-nowrap">
							<div class="inline-flex gap-2">
								{#if chat || s.canMove || killOn(s)}
									<div class="join">
										{#if chat}
											<button
												class="btn btn-sm"
												disabled={busy}
												aria-label="Whisper to {p.name}"
												onclick={() => open('whisper', row)}>Whisper</button
											>
										{/if}
										{#if s.canMove}
											<button
												class="btn btn-sm"
												disabled={busy}
												aria-label="Move {p.name} to another faction"
												onclick={() => open('move', row)}>Move</button
											>
										{/if}
										{#if killOn(s)}
											<button
												class="btn btn-sm"
												disabled={busy}
												aria-label="Kill {p.name}"
												onclick={() => kill(row)}>Kill</button
											>
										{/if}
									</div>
								{/if}
								{#if kickOn(s) || bansOn(s)}
									<div class="join">
										{#if kickOn(s)}
											<button
												class="btn btn-sm btn-danger"
												disabled={busy}
												aria-label="Kick {p.name}"
												onclick={() => open('kick', row)}>Kick</button
											>
										{/if}
										{#if bansOn(s)}
											<button
												class="btn btn-sm btn-danger"
												disabled={busy}
												aria-label="Ban {p.name}"
												onclick={() => (banning = row)}>Ban</button
											>
										{/if}
									</div>
								{/if}
							</div>
						</td>
					{/if}
				</tr>
			{:else}
				<tr
					><td
						colspan={8 + (several ? 1 : 0) + (actionsAny ? 1 : 0) + (chatAny ? 1 : 0)}
						class="py-6 text-center text-mist-600"
						>{all.length ? 'No matches.' : 'No players connected.'}</td
					></tr
				>
			{/each}
		</tbody>
	</table>
</div>
{#if !actionsAny}<p class="note">You have view-only access; player actions are disabled.</p>{/if}

{#if dialog}
	{@const { kind, row } = dialog}
	{@const p = row.p}
	{@const who = live ?? p}
	<Modal title="{TITLES[kind]} {p.name}" onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<div class="flex flex-wrap items-center gap-2 font-mono text-[12px] text-mist-400">
				<FactionChip faction={who.faction} scores={dialogServer?.scores} />
				{p.steamId}
				{#if several}<span class="font-sans">on {row.s.name}</span>{/if}
				{#if !live}<Badge tone="err">left the server</Badge>{/if}
			</div>
			{#if kind === 'whisper'}
				<div>
					<SavedMessages
						server={row.s}
						label="Message"
						labelFor="dialog-text"
						inputId="dialog-text"
						value={text}
						onpick={(t) => (text = t)}
						enabled={chatOn(row.s)}
					>
						<input
							id="dialog-text"
							class="input"
							type="text"
							placeholder="Private message…"
							maxlength={MAX_CHAT}
							bind:value={text}
						/>
					</SavedMessages>
				</div>
			{:else if kind === 'kick'}
				<label class="sr-only" for="dialog-text">Reason</label>
				<input
					id="dialog-text"
					class="input"
					type="text"
					placeholder="Reason (optional)…"
					maxlength="200"
					bind:value={text}
				/>
			{:else}
				<label class="sr-only" for="dialog-team">Faction</label>
				<select id="dialog-team" class="input" bind:value={team} disabled={!destinations.length}>
					{#each destinations as f (f)}<option value={f}>{f}</option>{/each}
				</select>
			{/if}
			<div class="flex justify-end gap-2">
				<button type="button" class="btn btn-ghost" data-close onclick={() => (dialog = null)}
					>Cancel</button
				>
				<button
					type="submit"
					class="btn {kind === 'kick' ? 'btn-danger' : 'btn-primary'}"
					disabled={busy ||
						!live ||
						(kind === 'whisper' && !text.trim()) ||
						(kind === 'move' && !destinations.includes(team))}>{SUBMIT[kind]}</button
				>
			</div>
		</form>
	</Modal>
{/if}

{#if grouping}
	<Modal
		title="Whisper to {pickedOn.length} player{pickedOn.length === 1 ? '' : 's'}"
		onclose={() => (grouping = false)}
	>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void sendGroup();
			}}
		>
			<p class="max-h-24 overflow-y-auto text-[12.5px] text-mist-400">
				{pickedOn.map((r) => (several ? `${r.p.name} (${r.s.name})` : r.p.name)).join(', ') ||
					'No one ticked is on the server.'}
			</p>
			{#if groupVia}
				<div>
					<SavedMessages
						server={groupVia}
						label="Message"
						labelFor="group-text"
						inputId="group-text"
						value={text}
						onpick={(t) => (text = t)}
						enabled={chatOn(groupVia)}
					>
						<input
							id="group-text"
							class="input"
							type="text"
							placeholder="Private message…"
							maxlength={MAX_CHAT}
							bind:value={text}
						/>
					</SavedMessages>
				</div>
			{/if}
			<div class="flex justify-end gap-2">
				<button type="button" class="btn btn-ghost" data-close onclick={() => (grouping = false)}
					>Cancel</button
				>
				<button
					type="submit"
					class="btn btn-primary"
					disabled={busy || !pickedOn.length || !text.trim()}>Send</button
				>
			</div>
		</form>
	</Modal>
{/if}

{#if banning}
	{@const { p, s } = banning}
	{#key banning.key}
		<BanDialog
			orgId={s.orgId}
			orgName={s.orgName}
			steamId={p.steamId}
			name={p.name}
			server={{ id: s.id, name: s.name }}
			canOrg={s.lists?.canEditOrgBans ?? false}
			banMessage={s.lists?.banMessage}
			reasons={s.lists?.banReasons ?? []}
			onclose={() => (banning = null)}
			ondone={() => onacted(s.id)}
		/>
	{/key}
{/if}
