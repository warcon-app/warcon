<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage, rconPost } from '$lib/api';
	import { can, fmtNum, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import BanDialog from '$lib/components/BanDialog.svelte';
	import { describeSync, STATE_TONE } from '$lib/lists';
	import type { DossierView, ListSyncSummary } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let d = $derived<DossierView>(data.dossier);
	let id = $derived(data.server.id);
	let operator = $derived(can(data.server.role, 'operator'));
	let admin = $derived(can(data.server.role, 'admin'));
	let base = $derived(`/api/servers/${encodeURIComponent(id)}/players/${d.steamId}`);
	let onThisServer = $derived(d.online?.serverId === id);
	let orgListsPath = $derived(`/api/orgs/${encodeURIComponent(data.server.orgId)}/lists`);

	let busy = $state(false);
	let banning = $state(false);

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

<svelte:head><title>{d.name} · {data.server.name} · {data.appName}</title></svelte:head>

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

<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
	{#each [['Sessions', fmtNum(d.summary.sessions)], ['Playtime', d.summary.sessions ? minutes(d.summary.minutes) : '—'], ['Kills', fmtNum(d.summary.kills)], ['Deaths', fmtNum(d.summary.deaths)], ['K/D', kd(d.summary.kills, d.summary.deaths)], ['First seen', d.summary.firstSeen ? fmtTime(d.summary.firstSeen) : '—']] as [label, value] (label)}
		<div class="panel py-4">
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
					<thead
						><tr
							><th>Server</th><th class="num">Sessions</th><th class="num">Playtime</th><th
								class="num">K</th
							><th class="num">D</th><th>Last seen</th></tr
						></thead
					>
					<tbody>
						{#each d.perServer as s (s.serverId)}
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
					<thead
						><tr
							><th>Joined</th><th>Server</th><th>Name</th><th>Faction</th><th class="num">Length</th
							><th class="num">K</th><th class="num">D</th><th class="num">Cash</th></tr
						></thead
					>
					<tbody>
						{#each d.recent as s (s.id)}
							<tr>
								<td class="whitespace-nowrap">{fmtTime(s.joinedAt)}</td>
								<td>{s.serverName}</td>
								<td>{s.name}</td>
								<td>{s.faction || '—'}</td>
								<td class="num"
									>{minutes(s.minutes)}{#if !s.leftAt}<Badge tone="ok" class="ml-1">live</Badge
										>{/if}</td
								>
								<td class="num">{s.kills}</td><td class="num">{s.deaths}</td>
								<td class="num">{fmtNum(s.cash)}</td>
							</tr>
						{:else}
							<tr><td colspan="8" class="py-6 text-center text-mist-600">No sessions yet.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
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
		{#if onThisServer && operator}
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
						disabled={busy || !whisper.trim()}
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
						disabled={busy}
						onclick={() =>
							act('kick', { steamId: d.steamId, reason: reason.trim() }, `Kick ${d.name}?`)}
						>Kick</button
					>
					<button
						class="btn btn-danger"
						disabled={busy || !admin}
						onclick={() =>
							act(
								'ban',
								{ steamId: d.steamId, reason: reason.trim() },
								`Ban ${d.name} (${d.steamId})? This persists in the server's config.`
							)}>Ban</button
					>
				</div>
			</div>
		{/if}

		<div class="panel">
			<div class="mb-3 flex items-center gap-2">
				<span class="label-sm mb-0!">Organisation lists</span>
				{#if d.orgLists.canEdit}
					<a
						href="/orgs/{encodeURIComponent(data.server.orgId)}/bans"
						class="ml-auto text-[12px] text-accent hover:underline">Open →</a
					>
				{/if}
			</div>
			<div class="space-y-3 text-[13px]">
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
						{#if d.orgLists.canEdit}
							<button class="btn btn-sm" disabled={busy} onclick={() => orgRemove('ban')}
								>Unban org-wide</button
							>
						{/if}
					{:else}
						<span class="text-mist-400">Not on the organisation's ban list.</span>
						{#if d.orgLists.canEdit}
							<button
								class="ml-auto btn btn-sm btn-danger"
								disabled={busy}
								onclick={() => (banning = true)}>Ban org-wide</button
							>
						{/if}
					{/if}
				</div>
				<div class="flex flex-wrap items-center gap-2">
					{#if d.orgLists.reserve}
						{@const r = d.orgLists.reserve}
						<Badge tone="accent">reserved slot</Badge>
						<span class="min-w-0 flex-1 truncate text-mist-400"
							>{r.reason || 'org-wide'} · priority {r.priority}{#if r.member}
								· member{/if}</span
						>
						<span class="inline-flex flex-wrap gap-1">
							{#each r.servers as s (s.serverId)}
								<span title="{s.serverName}: {s.state}{s.error ? ` — ${s.error}` : ''}"
									><Badge tone={STATE_TONE[s.state]}>{s.serverName}</Badge></span
								>
							{/each}
						</span>
						{#if d.orgLists.canEdit && !r.member}
							<button class="btn btn-sm" disabled={busy} onclick={() => orgRemove('reserve')}
								>Withdraw</button
							>
						{/if}
					{:else}
						<span class="text-mist-400">No reserved slot from the organisation.</span>
						{#if d.orgLists.canEdit}
							<button class="ml-auto btn btn-sm" disabled={busy} onclick={orgReserve}
								>Reserve a slot</button
							>
						{/if}
					{/if}
				</div>
			</div>
		</div>

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
				Advisory only, from the Steam Web API, this organisation's ban lists and the watchlist. It
				cannot see aim, position or input.
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
					<span class="text-mist-400"
						>Added by {d.watch.updatedByName || '?'} · {fmtTime(d.watch.updatedAt)}</span
					>
				</p>
				<button class="btn btn-sm" disabled={busy || !operator} onclick={() => setWatch(false)}
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
					<button class="btn" disabled={busy || !operator} onclick={() => setWatch(true)}
						>Watch</button
					>
				</div>
			{/if}
			<p class="note">
				Shared by every server in {data.server.orgName}. Watched players are flagged in the players
				table, and a trigger can act on it.
			</p>
		</div>

		<div class="panel">
			<span class="label-sm">Notes</span>
			{#if operator}
				<div class="mb-3">
					<textarea
						class="min-h-[70px] input"
						placeholder="Anything the next admin should know…"
						maxlength="2000"
						bind:value={note}></textarea>
					<div class="mt-2 flex justify-end">
						<button class="btn btn-sm btn-primary" disabled={busy || !note.trim()} onclick={addNote}
							>Add note</button
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
