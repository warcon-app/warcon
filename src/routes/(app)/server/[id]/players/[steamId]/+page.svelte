<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage, rconPost } from '$lib/api';
	import { fmtCash } from '$lib/cash';
	import { fmtDuration, fmtNum, fmtTime } from '$lib/format';
	import { causeLabel } from '$lib/causes';
	import { can } from '$lib/capabilities';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import CareerPanel from '$lib/components/CareerPanel.svelte';
	import CombatSummary from '$lib/components/CombatSummary.svelte';
	import { describeSync, STATE_TONE } from '$lib/lists';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { TableSort } from '$lib/table.svelte';
	import type { DossierView, ListSyncServer, ListSyncSummary } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let d = $derived<DossierView>(data.dossier);
	let id = $derived(data.server.id);
	let moderate = $derived(can(data.server.caps, 'players.moderate'));
	let chat = $derived(can(data.server.caps, 'chat.send'));
	let bans = $derived(can(data.server.caps, 'bans.manage'));
	let notes = $derived(can(data.server.caps, 'players.notes'));
	let base = $derived(`/api/servers/${encodeURIComponent(id)}/players/${d.steamId}`);
	let onThisServer = $derived(d.online?.serverId === id);
	let orgListsPath = $derived(`/api/orgs/${encodeURIComponent(data.server.orgId)}/lists`);

	let busy = $state(false);
	let banning = $state(false);

	const serverSort = new TableSort<DossierView['perServer'][number]>({
		server: { by: (s) => s.serverName },
		sessions: { by: (s) => s.sessions, dir: 'desc' },
		minutes: { by: (s) => s.minutes, dir: 'desc' },
		kills: { by: (s) => s.kills, dir: 'desc' },
		deaths: { by: (s) => s.deaths, dir: 'desc' },
		lastSeen: { by: (s) => s.lastSeen, dir: 'desc' }
	});
	let perServer = $derived(serverSort.sorted(d.perServer));
	const sessionSort = new TableSort<DossierView['recent'][number]>({
		joined: { by: (s) => s.joinedAt, dir: 'desc' },
		server: { by: (s) => s.serverName },
		name: { by: (s) => s.name },
		faction: { by: (s) => s.faction },
		minutes: { by: (s) => s.minutes, dir: 'desc' },
		seeded: { by: (s) => s.seedMinutes, dir: 'desc' },
		kills: { by: (s) => s.kills, dir: 'desc' },
		deaths: { by: (s) => s.deaths, dir: 'desc' },
		cash: { by: (s) => s.cash, dir: 'desc' }
	});
	let recent = $derived(sessionSort.sorted(d.recent));
	const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });

	/** remove the player from an org list (unban across the org, or withdraw the reserved slot) */
	async function orgRemove(kind: 'ban' | 'reserve') {
		const what =
			kind === 'ban'
				? `Unban ${d.name} across ${data.server.orgName}? The panel lifts the ban on every server it applied it to.`
				: `Withdraw ${d.name}'s reserved slot across ${data.server.orgName}?`;
		if (
			!(await confirmDialog(what, { okLabel: kind === 'ban' ? 'Unban' : 'Withdraw', danger: true }))
		)
			return;
		await run(async () => {
			const r = await api<{ sync: ListSyncSummary }>(
				'DELETE',
				`${orgListsPath}/${kind}/entries/${d.steamId}`
			);
			toast(describeSync(r.sync, kind === 'ban' ? 'Unbanned.' : 'Slot withdrawn.'), 'ok', 8000);
		}, '');
	}
	const orgReserve = () =>
		run(async () => {
			const r = await api<{ sync: ListSyncSummary }>('POST', `${orgListsPath}/reserve/entries`, {
				steamId: d.steamId,
				reason: d.name
			});
			toast(describeSync(r.sync, 'Reserved slot handed out.'), 'ok', 8000);
		}, '');
	let note = $state('');
	let watchReason = $state('');
	let whisper = $state('');
	let reason = $state('');
	$effect(() => {
		watchReason = d.watch.reason;
	});

	async function run(fn: () => Promise<unknown>, done: string) {
		busy = true;
		try {
			await fn();
			if (done) toast(done, 'ok');
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
	const addNote = () => {
		const body = note.trim();
		if (!body) return;
		void run(async () => {
			await api('POST', `${base}/notes`, { body });
			note = '';
		}, 'Note added.');
	};
	async function deleteNote(noteId: number) {
		if (!(await confirmDialog('Delete this note?', { okLabel: 'Delete', danger: true }))) return;
		await run(() => api('DELETE', `${base}/notes/${noteId}`), 'Note deleted.');
	}
	const setWatch = (watched: boolean) =>
		run(
			() => api('PUT', `${base}/watch`, { watched, reason: watchReason.trim() }),
			watched ? 'On the watchlist.' : 'Removed from the watchlist.'
		);
	const refreshSteam = () => run(() => api('POST', `${base}/steam`), 'Steam data refreshed.');

	async function act(action: string, params: object, confirm?: string) {
		if (confirm && !(await confirmDialog(confirm, { okLabel: 'Do it', danger: true }))) return;
		await run(async () => {
			const r = await rconPost<{ message?: string }>(id, action, params);
			toast(r?.message || `${action} done.`, 'ok');
		}, '');
	}

	// A ban goes on the server's own list, so the panel keeps the reason and who placed it.
	async function banHere() {
		const sure = await confirmDialog(`Ban ${d.name} (${d.steamId}) on ${data.server.name}?`, {
			okLabel: 'Do it',
			danger: true
		});
		if (!sure) return;
		await run(async () => {
			const res = await api<{ sync: ListSyncServer }>(
				'POST',
				`/api/servers/${encodeURIComponent(id)}/lists/ban/entries`,
				{ steamId: d.steamId, reason: reason.trim() }
			);
			toast(describeSync({ servers: [res.sync] }, `Banned ${d.name}.`), 'ok', 8000);
		}, '');
	}

	const SCOREBOARD_NOTE = "The game's scoreboard counters, added up over the player's sessions.";
	const minutes = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
	const kd = (k: number, dd: number) => (dd ? (k / dd).toFixed(2) : k ? `${k}.00` : '—');
	const RISK_TONE = { low: 'ok', medium: 'warn', high: 'err' } as const;
	const ACTION_LABEL: Record<string, string> = {
		'rcon.kick': 'kick',
		'rcon.ban': 'ban',
		'rcon.unban': 'unban',
		'rcon.kill': 'kill',
		'rcon.whisper': 'whisper',
		'rcon.changeTeam': 'move',
		'player.note': 'note',
		'player.note.delete': 'note deleted',
		'player.watch': 'watchlist'
	};
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div class="min-w-0">
		<a
			href="/server/{encodeURIComponent(id)}/players"
			class="caps text-mist-400 hover:text-mist-100">← Players</a
		>
		<h2 class="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
			{#if d.steam?.avatar}<img
					src={d.steam.avatar}
					alt=""
					class="h-8 w-8 rounded-[2px] border border-black"
					referrerpolicy="no-referrer"
				/>{/if}
			<span class="truncate">{d.name}</span>
			{#if d.online}<Badge tone="ok"
					>online · {onThisServer ? 'this server' : d.online.serverName}</Badge
				>{/if}
			{#if d.watch.watched}<Badge tone="warn">watchlist</Badge>{/if}
			<Badge tone={RISK_TONE[d.risk.level]}>risk {d.risk.level} · {d.risk.score}</Badge>
		</h2>
		<div class="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-mist-400">
			<span class="font-mono">{d.steamId}</span>
			{#if d.steam?.profileUrl}<a
					href={d.steam.profileUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="text-accent hover:underline">Steam profile ↗</a
				>{/if}
			{#if d.names.length > 1}<span
					>· also seen as {d.names.slice(1, 6).join(', ')}{d.names.length > 6 ? '…' : ''}</span
				>{/if}
		</div>
	</div>
</div>

<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-9">
	{#each [['Sessions', fmtNum(d.summary.sessions), 'A session is one stay on a server, from joining to leaving.'], ['Playtime', d.summary.sessions ? minutes(d.summary.minutes) : '—', ''], ['Seed progress', d.summary.seedReward ? `${fmtNum(d.summary.seedReward.minutes)} / ${fmtNum(d.summary.seedReward.requiredMinutes)} min` : '—', 'Unspent seeding time toward this server’s next reward. It resets when the reward is granted.'], ['Cash earned', fmtCash(d.summary.cash), 'Total cash earned across the servers visible to you.'], ['Kills', fmtNum(d.summary.kills), SCOREBOARD_NOTE], ['Deaths', fmtNum(d.summary.deaths), SCOREBOARD_NOTE], ['Longest alive', fmtDuration(d.summary.longestAliveSeconds), 'Longest recorded interval between joining, a death, a match start, and departure. Available for sessions tracked by the event feed.'], ['K/D', kd(d.summary.kills, d.summary.deaths), SCOREBOARD_NOTE], ['First seen', d.summary.firstSeen ? fmtTime(d.summary.firstSeen) : '—', '']] as [label, value, note] (label)}
		<div class="panel py-4" title={note || undefined}>
			<div class="caps text-mist-400">{label}</div>
			<div class="mt-1 font-display text-2xl font-semibold tabular">{value}</div>
		</div>
	{/each}
</div>

<div class="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
	<div class="space-y-4">
		{#if d.bannedOn.length}
			<div class="callout border-l-danger">
				<b
					>Banned on {d.bannedOn.length} of {d.orgServerCount} server{d.orgServerCount === 1
						? ''
						: 's'} in this organisation.</b
				>
				{#each d.bannedOn as b (b.serverId)}
					<div>
						{b.serverName}{#if b.reason}: {b.reason}{/if}{#if b.bannedBy}
							<span class="text-mist-400">(by {b.bannedBy})</span>{/if}
					</div>
				{/each}
			</div>
		{/if}

		<div class="panel">
			<span class="label-sm">By server</span>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<SortHeader sort={serverSort} key="server">Server</SortHeader>
							<SortHeader sort={serverSort} key="sessions" num>Sessions</SortHeader>
							<SortHeader sort={serverSort} key="minutes" num>Playtime</SortHeader>
							<SortHeader sort={serverSort} key="kills" num>K</SortHeader>
							<SortHeader sort={serverSort} key="deaths" num>D</SortHeader>
							<SortHeader sort={serverSort} key="lastSeen">Last seen</SortHeader>
						</tr>
					</thead>
					<tbody>
						{#each perServer as s (s.serverId)}
							<tr>
								<td
									><a
										href="/server/{encodeURIComponent(s.serverId)}/players/{d.steamId}"
										class="hover:text-accent hover:underline">{s.serverName}</a
									></td
								>
								<td class="num">{s.sessions}</td><td class="num">{minutes(s.minutes)}</td>
								<td class="num">{fmtNum(s.kills)}</td><td class="num">{fmtNum(s.deaths)}</td>
								<td class="whitespace-nowrap text-mist-400">{fmtTime(s.lastSeen)}</td>
							</tr>
						{:else}
							<tr
								><td colspan="6" class="py-6 text-center text-mist-600"
									>Never seen on a server you can access.</td
								></tr
							>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<div class="panel">
			<span class="label-sm">Recent sessions</span>
			<div class="max-h-[420px] table-wrap">
				<table>
					<thead>
						<tr>
							<SortHeader sort={sessionSort} key="joined">Joined</SortHeader>
							<SortHeader sort={sessionSort} key="server">Server</SortHeader>
							<SortHeader sort={sessionSort} key="name">Name</SortHeader>
							<SortHeader sort={sessionSort} key="faction">Faction</SortHeader>
							<SortHeader sort={sessionSort} key="minutes" num>Length</SortHeader>
							<SortHeader sort={sessionSort} key="seeded" num>Seeded</SortHeader>
							<SortHeader sort={sessionSort} key="kills" num>K</SortHeader>
							<SortHeader sort={sessionSort} key="deaths" num>D</SortHeader>
							<SortHeader sort={sessionSort} key="cash" num>Cash</SortHeader>
						</tr>
					</thead>
					<tbody>
						{#each recent as s (s.id)}
							<tr>
								<td class="whitespace-nowrap">{fmtTime(s.joinedAt)}</td>
								<td>{s.serverName}</td>
								<td>{s.name}</td>
								<td>{s.faction || '—'}</td>
								<td class="num"
									>{minutes(s.minutes)}{#if !s.leftAt}<Badge tone="ok" class="ml-1">live</Badge
										>{/if}</td
								>
								<td class="num">{s.seedMinutes ? minutes(s.seedMinutes) : '—'}</td>
								<td class="num">{s.kills}</td><td class="num">{s.deaths}</td>
								<td class="num">{fmtNum(s.cash)}</td>
							</tr>
						{:else}
							<tr><td colspan="9" class="py-6 text-center text-mist-600">No sessions yet.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		{#if d.combat}
			<div class="panel">
				<span class="label-sm">Combat</span>
				<p class="mb-3 text-[12.5px] text-mist-600">
					From the game's kill feed, across the organisation's servers you can see. A team kill
					counts as a kill here and a suicide as a death, and the feed only knows the time since it
					was set up, so these differ from the scoreboard totals at the top.
					<a
						href="/server/{encodeURIComponent(data.server.id)}/kills?player={encodeURIComponent(
							d.steamId
						)}"
						class="text-accent hover:underline">Every kill and death on this server →</a
					>
				</p>
				<CombatSummary
					combat={d.combat}
					hrefFor={(steamId) => `/server/${encodeURIComponent(id)}/players/${steamId}`}
				/>
				{#if d.combat.recent.length}
					<span class="mt-4 field-label">Recent kills and deaths</span>
					<div class="max-h-[320px] table-wrap">
						<table>
							<thead
								><tr
									><th>When</th><th>Server</th><th>Killer</th><th>Victim</th><th>Cause</th><th
										class="num">Distance</th
									><th></th></tr
								></thead
							>
							<tbody>
								{#each d.combat.recent as k (k.eventId)}
									<tr class={k.teamKill ? 'text-warn' : ''}>
										<td class="whitespace-nowrap text-mist-400" title={fmtTime(k.ts)}
											>{clock(k.ts)}</td
										>
										<td>{k.serverName}</td>
										<td class={k.killer?.steamId === d.steamId ? 'font-semibold' : ''}
											>{k.killer?.name ?? '—'}</td
										>
										<td class={k.victim.steamId === d.steamId ? 'font-semibold' : ''}
											>{k.victim.name}</td
										>
										<td>{causeLabel(k.cause) || (k.tags.includes('Falling') ? 'Fall' : '—')}</td>
										<td class="num"
											>{k.distanceM === null ? '—' : `${Math.round(k.distanceM)} m`}</td
										>
										<td class="whitespace-nowrap">
											{#if k.teamKill}<span class="chip">team kill</span>{/if}
											{#if k.suicide}<span class="chip">suicide</span>{/if}
											{#if k.headshot}<span class="chip">headshot</span>{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/if}

		<div class="panel">
			<div class="mb-3 flex items-center gap-2">
				<span class="label-sm mb-0!">Career</span>
				<a
					href="/server/{encodeURIComponent(id)}/leaderboard"
					class="ml-auto text-[12px] text-accent hover:underline">Leaderboards →</a
				>
			</div>
			<CareerPanel
				career={data.career}
				serverName={data.server.name}
				orgName={data.server.orgName}
				multiServer={data.multiServer}
				matchHref={(m) => `/server/${encodeURIComponent(m.serverId)}/matches/${m.matchId}`}
			/>
		</div>

		<div class="panel">
			<span class="label-sm">Admin actions on this player</span>
			<div class="max-h-[360px] table-wrap">
				<table>
					<thead
						><tr><th>When</th><th>By</th><th>Action</th><th>Server</th><th>Result</th></tr></thead
					>
					<tbody>
						{#each d.actions as a (a.id)}
							<tr>
								<td class="whitespace-nowrap">{fmtTime(a.ts)}</td>
								<td>{a.actorName || '—'}</td>
								<td><span class="chip">{ACTION_LABEL[a.action] || a.action}</span></td>
								<td>{a.serverName}</td>
								<td class="max-w-[360px]">
									<span class={a.outcome === 'ok' ? '' : 'text-danger'}
										>{a.message || a.outcome}</span
									>
								</td>
							</tr>
						{:else}
							<tr
								><td colspan="5" class="py-6 text-center text-mist-600"
									>Nothing you can see. Actions on this player would appear here.</td
								></tr
							>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</div>

	<div class="space-y-4 self-start">
		{#if onThisServer && (moderate || chat)}
			<div class="panel border-accent/40">
				<span class="label-sm">Quick actions (online here)</span>
				<div class="join w-full">
					<input
						class="input"
						type="text"
						placeholder="Private message…"
						maxlength="200"
						bind:value={whisper}
					/>
					<button
						class="btn btn-primary"
						disabled={busy || !chat || !whisper.trim()}
						onclick={async () => {
							await act('whisper', { steamId: d.steamId, message: whisper.trim() });
							whisper = '';
						}}>Whisper</button
					>
				</div>
				<div class="join join-wrap mt-2 w-full">
					<input
						class="input"
						type="text"
						placeholder="Reason (optional)…"
						maxlength="200"
						bind:value={reason}
					/>
					<button
						class="btn btn-danger"
						disabled={busy || !moderate}
						onclick={() =>
							act('kick', { steamId: d.steamId, reason: reason.trim() }, `Kick ${d.name}?`)}
						>Kick</button
					>
					<button class="btn btn-danger" disabled={busy || !bans} onclick={banHere}>Ban</button>
				</div>
			</div>
		{/if}

		<!-- an entry, its reason and who added it are for those who may edit that list -->
		{#if d.orgLists.canBan || d.orgLists.canReserve}
			<div class="panel">
				<div class="mb-3 flex items-center gap-2">
					<span class="label-sm mb-0!">Organisation lists</span>
					<a
						href="/orgs/{encodeURIComponent(data.server.orgId)}/{d.orgLists.canBan
							? 'bans'
							: 'reserved'}"
						class="ml-auto text-[12px] text-accent hover:underline">Open the lists →</a
					>
				</div>
				<div class="space-y-3 text-[13px]">
					{#if d.orgLists.canBan}
						<div class="flex flex-wrap items-center gap-2">
							{#if d.orgLists.ban}
								{@const b = d.orgLists.ban}
								<Badge tone="err">banned org-wide</Badge>
								<span class="min-w-0 flex-1 truncate text-mist-400"
									>{b.reason || 'no reason'} · by {b.addedByName || '—'}{#if b.expiresAt}
										· until {fmtTime(b.expiresAt)}{/if}</span
								>
								<span class="inline-flex flex-wrap gap-1">
									{#each b.servers as s (s.serverId)}
										<span title="{s.serverName}: {s.state}{s.error ? ` — ${s.error}` : ''}"
											><Badge tone={STATE_TONE[s.state]}>{s.serverName}</Badge></span
										>
									{/each}
								</span>
								<button class="btn btn-sm" disabled={busy} onclick={() => orgRemove('ban')}
									>Unban org-wide</button
								>
							{:else}
								<span class="text-mist-400">Not on the organisation's ban list.</span>
								<button
									class="ml-auto btn btn-sm btn-danger"
									disabled={busy}
									onclick={() => (banning = true)}>Ban org-wide</button
								>
							{/if}
						</div>
					{/if}
					{#if d.orgLists.canReserve}
						<div class="flex flex-wrap items-center gap-2">
							{#if d.orgLists.reserve}
								{@const r = d.orgLists.reserve}
								<Badge tone="accent">reserved slot</Badge>
								<span class="min-w-0 flex-1 truncate text-mist-400"
									>{r.reason || 'org-wide'}{#if r.member}
										· member{/if}{#if r.expiresAt}
										· until {fmtTime(r.expiresAt)}{/if}</span
								>
								<span class="inline-flex flex-wrap gap-1">
									{#each r.servers as s (s.serverId)}
										<span title="{s.serverName}: {s.state}{s.error ? ` — ${s.error}` : ''}"
											><Badge tone={STATE_TONE[s.state]}>{s.serverName}</Badge></span
										>
									{/each}
								</span>
								{#if !r.member}
									<button class="btn btn-sm" disabled={busy} onclick={() => orgRemove('reserve')}
										>Withdraw</button
									>
								{/if}
							{:else}
								<span class="text-mist-400">No reserved slot from the organisation.</span>
								<button class="ml-auto btn btn-sm" disabled={busy} onclick={orgReserve}
									>Reserve a slot</button
								>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="panel">
			<div class="mb-3 flex items-center gap-2">
				<span class="label-sm mb-0!">Risk</span>
				<Badge tone={RISK_TONE[d.risk.level]} class="ml-auto">{d.risk.level} · {d.risk.score}</Badge
				>
			</div>
			{#if d.risk.reasons.length}
				<ul class="space-y-1 text-[13px]">
					{#each d.risk.reasons as r (r.code + r.text)}
						<li class="flex gap-2">
							<span class="font-mono text-[12px] text-mist-600 tabular">+{r.weight}</span>
							<span>{r.text}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-[13px] text-mist-400">Nothing stands out.</p>
			{/if}
			<p class="note">
				Advisory only, from the Steam Web API, recorded game stats, this organisation's ban lists
				and the watchlist. It cannot see aim, position or input.
				{#if !d.steamEnabled}<span class="text-warn"
						>Steam lookup is off (set STEAM_API_KEY), so account age and VAC status are unknown.</span
					>{/if}
			</p>
		</div>

		<div class="panel">
			<div class="mb-3 flex items-center gap-2">
				<span class="label-sm mb-0!">Steam</span>
				{#if d.steamEnabled}
					<button class="ml-auto btn btn-sm" onclick={refreshSteam} disabled={busy}>Refresh</button>
				{/if}
			</div>
			{#if d.steam}
				{#if d.steam.error}<p class="mb-2 text-[13px] text-warn">{d.steam.error}</p>{/if}
				<div class="kv">
					<span class="text-mist-400">Persona</span><span>{d.steam.persona || '—'}</span>
				</div>
				<div class="kv">
					<span class="text-mist-400">Account age</span>
					<span
						>{#if d.steam.accountAgeDays === null}unknown ({d.steam.public
								? 'no date'
								: 'private profile'}){:else}{d.steam.accountAgeDays} days · since {fmtTime(
								d.steam.accountCreatedAt
							).slice(0, 12)}{/if}</span
					>
				</div>
				<div class="kv">
					<span class="text-mist-400">VAC bans</span>
					<span class={d.steam.vacBans ? 'text-danger' : ''}
						>{d.steam.vacBans}{#if d.steam.vacBans && d.steam.daysSinceLastBan !== null}
							· last {d.steam.daysSinceLastBan} days ago{/if}</span
					>
				</div>
				<div class="kv">
					<span class="text-mist-400">Game bans</span>
					<span class={d.steam.gameBans ? 'text-danger' : ''}>{d.steam.gameBans}</span>
				</div>
				<div class="kv">
					<span class="text-mist-400">Steam friends</span>
					<span>
						{#if d.steam.friendsState === 'private'}private list
						{:else if d.steam.friendsState === 'unknown'}unavailable
						{:else}{d.steam.bannedFriends} banned among {d.steam.friendsChecked} checked{#if d.steam.friendsState === 'partial'}
								of {d.steam.friendsTotal}{/if}{/if}
					</span>
				</div>
				{#if d.steam.communityBanned || d.steam.economyBan !== 'none'}
					<div class="kv">
						<span class="text-mist-400">Other</span>
						<span class="text-warn"
							>{[
								d.steam.communityBanned ? 'community ban' : '',
								d.steam.economyBan !== 'none' ? `economy: ${d.steam.economyBan}` : ''
							]
								.filter(Boolean)
								.join(', ')}</span
						>
					</div>
				{/if}
				<p class="note">Fetched {fmtTime(d.steam.fetchedAt)}.</p>
			{:else if d.steamEnabled}
				<p class="text-[13px] text-mist-400">
					Not looked up yet. <button class="text-accent underline" onclick={refreshSteam}
						>Fetch now</button
					>.
				</p>
			{:else}
				<p class="text-[13px] text-mist-400">
					Set <code class="font-mono">STEAM_API_KEY</code> to see persona, account age and ban records.
				</p>
			{/if}
		</div>

		<div class="panel {d.watch.watched ? 'border-warn/50' : ''}">
			<span class="label-sm">Watchlist</span>
			{#if d.watch.watched}
				<p class="mb-2 text-[13px]">
					On the watchlist{#if d.watch.reason}: <b>{d.watch.reason}</b>{/if}.
					{#if notes}
						<span class="text-mist-400"
							>Added by {d.watch.updatedByName || '?'} · {fmtTime(d.watch.updatedAt)}</span
						>
					{/if}
				</p>
				<button class="btn btn-sm" disabled={busy || !notes} onclick={() => setWatch(false)}
					>Remove from watchlist</button
				>
			{:else}
				<div class="join w-full">
					<input
						class="input"
						type="text"
						placeholder="Why (shown to every admin)…"
						maxlength="300"
						bind:value={watchReason}
					/>
					<button class="btn" disabled={busy || !notes} onclick={() => setWatch(true)}>Watch</button
					>
				</div>
			{/if}
			<p class="note">
				Shared by every server in {data.server.orgName}. Watched players are flagged in the players
				table, and a trigger can act on it.
			</p>
		</div>

		<!-- notes are read by those who may write them -->
		{#if notes}
			<div class="panel">
				<span class="label-sm">Notes</span>
				{#if notes}
					<div class="mb-3">
						<textarea
							class="min-h-[70px] input"
							placeholder="Anything the next admin should know…"
							maxlength="2000"
							bind:value={note}></textarea>
						<div class="mt-2 flex justify-end">
							<button
								class="btn btn-sm btn-primary"
								disabled={busy || !note.trim()}
								onclick={addNote}>Add note</button
							>
						</div>
					</div>
				{/if}
				<div class="space-y-2">
					{#each d.notes as n (n.id)}
						<div class="rounded-ctl border border-black bg-ink-950 px-3 py-2">
							<div class="mb-1 flex items-center gap-2 text-[12px] text-mist-400">
								<b class="text-mist-100">{n.authorName || '—'}</b>
								<span>{fmtTime(n.createdAt)}</span>
								{#if n.deletable}<button
										class="ml-auto btn btn-sm btn-ghost"
										aria-label="Delete note"
										disabled={busy}
										onclick={() => deleteNote(n.id)}>✕</button
									>{/if}
							</div>
							<div class="text-[13.5px] whitespace-pre-wrap">{n.body}</div>
						</div>
					{:else}
						<p class="text-[13px] text-mist-600">No notes yet.</p>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>

{#if banning}
	<BanDialog
		orgId={data.server.orgId}
		orgName={data.server.orgName}
		steamId={d.steamId}
		name={d.name}
		canOrg
		onclose={() => (banning = false)}
		ondone={() => invalidateAll()}
	/>
{/if}
