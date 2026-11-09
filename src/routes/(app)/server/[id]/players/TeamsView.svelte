<script lang="ts">
	// The Players tab's Teams view: one column per faction, players dragged between them (or sent to
	// the next side with a button, or picked from a menu on a phone), Shuffle and Even up to fill in a
	// plan, and Save to move everyone in it, one changeTeam each without the kill. Nobody moves until
	// Save. Without Move the columns are only shown.
	import { untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { ApiError, errorMessage, rconPost } from '$lib/api';
	import { factionColor } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { deal, evenUp, recordRating, type PlanPlayer, type ShuffleMode } from '$lib/team-plan';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { FactionScore, Player, PlayerMark } from '$lib/types';

	let {
		serverId,
		players,
		scores,
		marks,
		canMove
	}: {
		serverId: string;
		players: Player[];
		scores: FactionScore[] | null | undefined;
		marks: Record<string, PlayerMark>;
		canMove: boolean;
	} = $props();

	/** About three moves a second, as the Team balance rule sends them. */
	const MOVE_GAP_MS = 340;
	const COLS: Record<number, string> = {
		1: 'md:grid-cols-1',
		2: 'md:grid-cols-2',
		3: 'md:grid-cols-3'
	};
	const SHUFFLES: { mode: ShuffleMode; label: string; hint: string }[] = [
		{ mode: 'random', label: 'Random', hint: 'Even numbers, anyone can land on any side.' },
		{
			mode: 'record',
			label: 'Spread by record here',
			hint: 'Deals players out by their K/D over every match they have finished on this server.'
		}
	];

	/** SteamID -> the side the player is to go to */
	const plan = new SvelteMap<string, string>();
	/** sides Shuffle and Even up leave out */
	const out = new SvelteSet<string>();
	let clans = $state(true);
	let restored = $state(false);
	let dragging = $state<string | null>(null);
	let over = $state<string | null>(null);
	let shuffleOpen = $state(false);
	/** the card whose side menu is open (phones) */
	let sideMenu = $state<string | null>(null);
	let confirming = $state(false);

	type RowState = 'waiting' | 'moving' | 'moved' | 'there' | 'gone' | 'failed';
	interface RunRow {
		steamId: string;
		name: string;
		to: string;
		state: RowState;
		note: string;
	}
	let run = $state<{
		rows: RunRow[];
		finished: boolean;
		stopping: boolean;
		stopped: string;
	} | null>(null);
	let busy = $derived(!!run && !run.finished);
	let destroyed = false;
	$effect(() => () => {
		destroyed = true;
	});

	const storeKey = () => `warcon.teams.${serverId}`;
	$effect(() => {
		untrack(() => {
			try {
				const saved = JSON.parse(localStorage.getItem(storeKey()) || '{}');
				if (Array.isArray(saved.out))
					for (const s of saved.out) if (typeof s === 'string') out.add(s);
				if (typeof saved.clans === 'boolean') clans = saved.clans;
			} catch {
				/* nothing saved, or private mode */
			}
			restored = true;
		});
	});
	$effect(() => {
		const view = { out: [...out], clans };
		if (!restored) return;
		try {
			localStorage.setItem(storeKey(), JSON.stringify(view));
		} catch {
			/* private mode */
		}
	});

	/** the match's factions in the game's order, then any a player is on that the status leaves out */
	let factions = $derived.by(() => {
		const names = (scores ?? []).map((f) => f.name);
		for (const p of players) if (p.faction && !names.includes(p.faction)) names.push(p.faction);
		return names;
	});
	let byId = $derived(new Map(players.map((p) => [p.steamId, p])));
	const targetOf = (p: Player) => plan.get(p.steamId) ?? p.faction;
	let openSides = $derived(factions.filter((f) => !out.has(f)));

	// A planned move is done once the player is on that side, however they got there. A player who
	// is not on the list keeps their place in the plan: the list empties for half a minute at a map
	// change.
	$effect(() => {
		const now = byId;
		untrack(() => {
			for (const [id, side] of plan) if (now.get(id)?.faction === side) plan.delete(id);
		});
	});

	let moves = $derived(
		players.filter((p) => {
			const to = plan.get(p.steamId);
			return to !== undefined && to !== p.faction;
		})
	);
	const byName = (a: Player, b: Player) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
	let columns = $derived(
		factions.map((f) => {
			const mine = players.filter((p) => targetOf(p) === f);
			return {
				name: f,
				color: factionColor(f, scores),
				now: players.filter((p) => p.faction === f).length,
				open: !out.has(f),
				cards: [
					...mine.filter((p) => p.faction !== f).sort(byName),
					...mine.filter((p) => p.faction === f).sort(byName)
				]
			};
		})
	);
	let sideless = $derived(players.filter((p) => targetOf(p) === null).sort(byName));
	let inPlay = $derived(columns.filter((c) => c.open));
	let spread = $derived(
		inPlay.length
			? Math.max(...inPlay.map((c) => c.cards.length)) -
					Math.min(...inPlay.map((c) => c.cards.length))
			: 0
	);
	let groups = $derived(
		factions
			.map((f) => ({
				name: f,
				color: factionColor(f, scores),
				who: moves.filter((p) => plan.get(p.steamId) === f).map((p) => p.name)
			}))
			.filter((g) => g.who.length)
	);

	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

	function place(steamId: string, side: string) {
		const p = byId.get(steamId);
		if (!p || busy) return;
		if (side === p.faction) plan.delete(steamId);
		else plan.set(steamId, side);
	}
	function next(p: Player) {
		const i = factions.indexOf(targetOf(p) ?? '');
		place(p.steamId, factions[(i + 1) % factions.length]);
	}
	function apply(sides: Map<string, string>) {
		plan.clear();
		for (const p of players) {
			const to = sides.get(p.steamId);
			if (to !== undefined && to !== p.faction) plan.set(p.steamId, to);
		}
	}
	const planPlayers = (): PlanPlayer[] =>
		players.map((p) => ({ steamId: p.steamId, name: p.name, side: p.faction }));
	function twoSides() {
		if (openSides.length >= 2) return true;
		toast('Tick In shuffle on at least two sides.', 'err');
		return false;
	}
	function shuffle(mode: ShuffleMode) {
		shuffleOpen = false;
		if (busy || !twoSides()) return;
		const rating =
			mode === 'record' ? (p: PlanPlayer) => recordRating(marks[p.steamId]?.record) : undefined;
		apply(deal(planPlayers(), openSides, { clans, rating }));
	}
	function even() {
		if (busy || !twoSides()) return;
		apply(evenUp(planPlayers(), openSides, { clans }));
	}

	function dragStart(e: DragEvent, p: Player) {
		if (!canMove || busy) return;
		e.dataTransfer?.setData('text/plain', p.steamId);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
		dragging = p.steamId;
	}
	function dragOver(e: DragEvent, side: string) {
		if (!dragging) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		over = side;
	}
	function dragLeave(e: DragEvent, side: string) {
		const into = e.relatedTarget as Node | null;
		if (over === side && !(e.currentTarget as Node).contains(into)) over = null;
	}
	function drop(e: DragEvent, side: string) {
		if (!dragging) return;
		e.preventDefault();
		place(dragging, side);
		dragging = null;
		over = null;
	}
	function dragEnd() {
		dragging = null;
		over = null;
	}

	/**
	 * Moves everyone in the plan, one at a time and about three a second, without the kill. A player
	 * who has left, or is on the side already, is passed over; a refusal about one player is noted
	 * and the run goes on; anything else (the server, the panel's own limit, the connection) stops
	 * it. Whoever was not moved stays in the plan.
	 */
	async function save() {
		confirming = false;
		const rows: RunRow[] = moves.map((p) => ({
			steamId: p.steamId,
			name: p.name,
			to: plan.get(p.steamId)!,
			state: 'waiting',
			note: ''
		}));
		if (!rows.length || busy) return;
		run = { rows, finished: false, stopping: false, stopped: '' };
		const r = run;
		let last = 0;
		for (const row of r.rows) {
			if (r.stopping || destroyed) break;
			const p = byId.get(row.steamId);
			if (!p) {
				row.state = 'gone';
				continue;
			}
			if (p.faction === row.to) {
				row.state = 'there';
				continue;
			}
			const wait = last + MOVE_GAP_MS - Date.now();
			if (wait > 0) await new Promise((done) => setTimeout(done, wait));
			if (r.stopping || destroyed) break;
			last = Date.now();
			row.state = 'moving';
			try {
				await rconPost(serverId, 'changeTeam', {
					steamId: row.steamId,
					faction: row.to,
					kill: false
				});
				row.state = 'moved';
			} catch (err) {
				const code = err instanceof ApiError ? err.code : undefined;
				if (code === 'same_side') row.state = 'there';
				else if (code === 'player_not_found') row.state = 'gone';
				else {
					row.state = 'failed';
					row.note = errorMessage(err);
					if (!(err instanceof ApiError && err.status === 400)) {
						r.stopped = row.note;
						break;
					}
				}
			}
		}
		r.finished = true;
	}
	function closeRun() {
		if (!run) return;
		if (run.finished) run = null;
		else run.stopping = true;
	}
	const STATE_TEXT: Record<RowState, string> = {
		waiting: 'waiting',
		moving: 'moving…',
		moved: 'moved',
		there: 'already there',
		gone: 'left the server',
		failed: ''
	};
	let runDone = $derived(
		run ? run.rows.filter((x) => x.state !== 'waiting' && x.state !== 'moving').length : 0
	);
	let runMoved = $derived(
		run ? run.rows.filter((x) => x.state === 'moved' || x.state === 'there').length : 0
	);
	let runTitle = $derived(
		!run
			? ''
			: !run.finished
				? `Moving ${plural(run.rows.length, 'player')} · ${runDone} done`
				: runMoved === run.rows.length
					? `Moved ${plural(run.rows.length, 'player')}`
					: `Moved ${runMoved} of ${plural(run.rows.length, 'player')}`
	);
</script>

<svelte:window
	onclick={(e) => {
		if (!(e.target as Element | null)?.closest?.('[data-team-menu]')) {
			shuffleOpen = false;
			sideMenu = null;
		}
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			shuffleOpen = false;
			sideMenu = null;
		}
	}}
/>

{#snippet card(p: Player)}
	{@const to = targetOf(p)}
	{@const moved = to !== p.faction}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex min-h-11 items-center gap-2 rounded-ctl border px-2 py-1 text-[13.5px] sm:min-h-[34px] sm:py-0 {moved
			? 'border-accent/60 bg-accent/[0.09]'
			: 'border-white/[0.06] bg-ink-900'} {canMove && !busy ? 'sm:cursor-grab' : ''} {dragging ===
		p.steamId
			? 'opacity-40'
			: ''}"
		draggable={canMove && !busy}
		ondragstart={(e) => dragStart(e, p)}
		ondragend={dragEnd}
	>
		{#if canMove}
			<svg
				class="hidden h-3.5 w-3.5 shrink-0 text-mist-600 sm:block"
				viewBox="0 0 24 24"
				fill="currentColor"
				aria-hidden="true"
				><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle
					cx="9"
					cy="12"
					r="1.6"
				/><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle
					cx="15"
					cy="18"
					r="1.6"
				/></svg
			>
		{/if}
		<div class="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
			<span class="truncate font-medium text-mist-100">{p.name}</span>
			<span class="flex items-center gap-1.5 text-[12px] whitespace-nowrap text-mist-400">
				<span class="font-mono text-[11.5px] tabular sm:hidden">{p.kills}–{p.deaths}</span>
				{#if marks[p.steamId]?.firstVisit}<Badge tone="info">new</Badge>{/if}
				{#if moved}
					<span class="inline-flex items-center gap-1.5 text-accent"
						>from <span
							class="inline-block h-2 w-2 rounded-full"
							style="background:{factionColor(p.faction, scores)}"
						></span>{p.faction ?? 'no side'}</span
					>
				{/if}
			</span>
		</div>
		<span class="ml-auto hidden font-mono text-[11.5px] text-mist-400 tabular sm:inline"
			>{p.kills}–{p.deaths}</span
		>
		{#if canMove}
			<button
				type="button"
				class="hidden h-[26px] w-[26px] shrink-0 items-center justify-center rounded-ctl text-mist-400 hover:bg-ink-700 hover:text-mist-100 disabled:opacity-40 sm:inline-flex"
				aria-label="Move {p.name} to the next side"
				title="Move to the next side"
				disabled={busy || !factions.length}
				onclick={() => next(p)}
				><svg
					class="h-3.5 w-3.5"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"><path d="M7 7h12l-3-3M17 17H5l3 3" /></svg
				></button
			>
			{#if moved && p.faction}
				{@const from = p.faction}
				<button
					type="button"
					class="hidden h-[26px] w-[26px] shrink-0 items-center justify-center rounded-ctl text-mist-400 hover:bg-ink-700 hover:text-mist-100 disabled:opacity-40 sm:inline-flex"
					aria-label="Leave {p.name} on {from}"
					title="Leave on their side"
					disabled={busy}
					onclick={() => place(p.steamId, from)}
					><svg
						class="h-3.5 w-3.5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg
					></button
				>
			{/if}
			<div class="relative ml-auto sm:hidden" data-team-menu>
				<button
					type="button"
					class="inline-flex h-9 items-center gap-1.5 rounded-ctl border border-black bg-ink-800 px-2.5 text-[12.5px] text-mist-100 disabled:opacity-40"
					aria-label="Side for {p.name}: {to ?? 'none'}"
					aria-haspopup="menu"
					aria-expanded={sideMenu === p.steamId}
					disabled={busy}
					onclick={() => (sideMenu = sideMenu === p.steamId ? null : p.steamId)}
					><span
						class="inline-block h-2 w-2 rounded-full"
						style="background:{factionColor(to, scores)}"
					></span>Side <span class="text-[10px] text-mist-400">▼</span></button
				>
				{#if sideMenu === p.steamId}
					<div
						class="absolute top-[calc(100%+6px)] right-0 z-40 w-[230px] rise rounded-card border border-black bg-ink-900 p-1 shadow-pop"
						role="menu"
						aria-label="Side for {p.name}"
					>
						<span class="block px-3 pt-2 pb-1.5 caps text-[10px] text-mist-400"
							>{p.name} plays on</span
						>
						{#each columns as c (c.name)}
							<button
								type="button"
								class="menu-item min-h-11 {c.name === to ? 'bg-ink-800' : ''}"
								role="menuitemradio"
								aria-checked={c.name === to}
								onclick={() => {
									place(p.steamId, c.name);
									sideMenu = null;
								}}
								><span class="inline-block h-2.5 w-2.5 rounded-full" style="background:{c.color}"
								></span>{c.name}<span class="ml-auto text-[12px] text-mist-400"
									>{c.cards.length}</span
								></button
							>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#if canMove}
	<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
		<div class="relative w-full sm:w-auto" data-team-menu>
			<div class="join w-full sm:w-auto">
				<button
					type="button"
					class="btn flex-1 sm:flex-none"
					aria-haspopup="menu"
					aria-expanded={shuffleOpen}
					disabled={busy || !players.length}
					onclick={() => (shuffleOpen = !shuffleOpen)}
					>Shuffle <span class="text-[10px] text-mist-400">▼</span></button
				><button
					type="button"
					class="btn flex-1 sm:flex-none"
					disabled={busy || !players.length}
					onclick={even}>Even up</button
				>
			</div>
			{#if shuffleOpen}
				<div
					class="absolute top-[calc(100%+6px)] left-0 z-40 w-[320px] max-w-[calc(100vw-2rem)] rise rounded-card border border-black bg-ink-900 p-1 shadow-pop"
					role="menu"
					aria-label="Shuffle"
				>
					{#each SHUFFLES as s (s.mode)}
						<button
							type="button"
							class="menu-item flex-col items-start gap-0.5"
							role="menuitem"
							onclick={() => shuffle(s.mode)}
							><span class="text-[13.5px] font-medium">{s.label}</span><span
								class="text-[12.5px] leading-snug text-mist-400">{s.hint}</span
							></button
						>
					{/each}
				</div>
			{/if}
		</div>
		<label class="inline-flex min-h-11 items-center gap-2 text-[13px] text-mist-400 sm:min-h-0">
			<input type="checkbox" bind:checked={clans} disabled={busy} /> Keep clan tags together
		</label>
		<span class="text-[12.5px] text-mist-400 sm:ml-auto">
			{#if inPlay.length}<span class="font-medium text-mist-100"
					>{inPlay.map((c) => `${c.name} ${c.cards.length}`).join(' v ')}</span
				>
				· {spread <= 1 ? 'even' : `off by ${spread}`} ·{/if}
			{moves.length ? `${plural(moves.length, 'move')} planned` : 'no moves planned'}
		</span>
		<div class="flex w-full gap-2 sm:w-auto">
			<button
				type="button"
				class="btn btn-ghost"
				disabled={busy || !plan.size}
				onclick={() => plan.clear()}>Reset</button
			>
			<button
				type="button"
				class="btn flex-1 btn-primary sm:flex-none"
				disabled={busy || !moves.length}
				onclick={() => (confirming = true)}
				>{moves.length ? `Save · ${plural(moves.length, 'move')}` : 'Save'}</button
			>
		</div>
	</div>
{/if}

{#if !players.length}
	<p class="py-6 text-center text-mist-600">No players connected.</p>
{:else}
	{#if sideless.length}
		<div class="mb-3 rounded-card border border-black bg-ink-950">
			<div
				class="flex min-h-11 items-center gap-2 border-b border-white/[0.06] px-3 py-2 sm:min-h-0"
			>
				<span class="text-[14px] font-semibold text-mist-400">No side yet</span>
				<span class="font-display text-[21px] leading-none font-semibold text-mist-400 tabular"
					>{sideless.length}</span
				>
			</div>
			<div class="grid grid-cols-1 gap-1 p-2 md:grid-cols-3">
				{#each sideless as p (p.steamId)}{@render card(p)}{/each}
			</div>
		</div>
	{/if}
	<div class="grid grid-cols-1 items-start gap-3 {COLS[columns.length] ?? 'md:grid-cols-3'}">
		{#each columns as c (c.name)}
			<section
				class="rounded-card border bg-ink-950 transition-colors {over === c.name
					? 'border-accent bg-accent/5'
					: 'border-black'}"
				aria-label={c.name}
				ondragover={(e) => dragOver(e, c.name)}
				ondragleave={(e) => dragLeave(e, c.name)}
				ondrop={(e) => drop(e, c.name)}
			>
				<div
					class="flex min-h-11 items-center gap-2 border-b border-white/[0.06] px-3 py-2 sm:min-h-0"
				>
					<span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style="background:{c.color}"
					></span>
					<span class="text-[14px] font-semibold {c.open ? 'text-mist-100' : 'text-mist-400'}"
						>{c.name}</span
					>
					<span
						class="font-display text-[21px] leading-none font-semibold tabular {c.open
							? 'text-mist-100'
							: 'text-mist-400'}">{c.cards.length}</span
					>
					{#if c.cards.length !== c.now}<span class="text-[12px] text-mist-400">was {c.now}</span
						>{/if}
					{#if canMove}
						<label
							class="ml-auto inline-flex min-h-11 items-center gap-1.5 caps text-[10px] text-mist-400 sm:min-h-0"
						>
							<input
								type="checkbox"
								checked={c.open}
								disabled={busy}
								aria-label="{c.name} in the shuffle"
								onchange={() => (out.has(c.name) ? out.delete(c.name) : out.add(c.name))}
							/> In shuffle
						</label>
					{/if}
				</div>
				<div class="flex flex-col gap-1 p-2">
					{#each c.cards as p (p.steamId)}{@render card(p)}{/each}
					{#if !c.cards.length}
						<div
							class="rounded-ctl border border-dashed border-white/[0.14] px-3 py-5 text-center text-[12.5px] text-mist-400"
						>
							{canMove ? 'No one here. Drag players onto this side.' : 'No one on this side.'}
						</div>
					{/if}
				</div>
			</section>
		{/each}
	</div>
{/if}
<p class="note">
	{#if canMove}
		Shuffle deals everyone into even teams on the sides ticked In shuffle, keeping clan tags
		together when that is ticked; Even up moves the fewest players to get the sides within one.
		Neither moves anyone: drag players around afterwards, and nothing happens in game until Save. A
		player who picks the planned side themselves drops out of the plan.
	{:else}
		Arranging the teams needs Move on this server.
	{/if}
</p>

{#if confirming}
	<Modal title="Move {plural(moves.length, 'player')}" onclose={() => (confirming = false)}>
		{#each groups as g (g.name)}
			<div class="flex flex-col gap-1 border-b border-white/[0.06] py-2.5 first:pt-0">
				<span class="inline-flex items-center gap-2 caps text-mist-400"
					><span class="inline-block h-2.5 w-2.5 rounded-full" style="background:{g.color}"
					></span>To {g.name}</span
				>
				<span class="text-[13.5px] leading-normal text-mist-100">{g.who.join(', ')}</span>
			</div>
		{/each}
		<p class="note">
			Each player is switched to the new side without a kill, as Team balance switches them. The
			moves go out one at a time, about three a second; anyone who has left, or is on that side
			already, is passed over.
		</p>
		{#snippet actions()}
			<button type="button" class="btn btn-ghost" data-close onclick={() => (confirming = false)}
				>Cancel</button
			>
			<button type="button" class="btn btn-primary" onclick={save}
				>Move {plural(moves.length, 'player')}</button
			>
		{/snippet}
	</Modal>
{/if}

{#if run}
	{@const r = run}
	<Modal title={runTitle} onclose={closeRun}>
		{#if !r.finished}
			<div class="mb-3.5 h-1.5 overflow-hidden rounded-full border border-black bg-ink-950">
				<div
					class="h-full bg-accent transition-[width]"
					style="width:{(100 * runDone) / r.rows.length}%"
				></div>
			</div>
		{/if}
		<div class="max-h-[50vh] overflow-y-auto rounded-card border border-black bg-ink-950">
			{#each r.rows as row (row.steamId)}
				<div
					class="flex items-center gap-2.5 border-b border-white/[0.06] px-3 py-1.5 text-[13.5px] last:border-0"
				>
					{#if row.state === 'moved' || row.state === 'there'}
						<svg
							class="h-[15px] w-[15px] shrink-0 {row.state === 'moved'
								? 'text-ok'
								: 'text-mist-400'}"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.4"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg
						>
					{:else if row.state === 'gone' || row.state === 'failed'}
						<svg
							class="h-[15px] w-[15px] shrink-0 text-danger"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.4"
							stroke-linecap="round"
							aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg
						>
					{:else}
						<svg
							class="h-[15px] w-[15px] shrink-0 {row.state === 'moving'
								? 'text-accent'
								: 'text-mist-600'}"
							viewBox="0 0 24 24"
							fill={row.state === 'moving' ? 'currentColor' : 'none'}
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"><circle cx="12" cy="12" r="4.5" /></svg
						>
					{/if}
					<span class="truncate font-medium text-mist-100">{row.name}</span>
					<span class="shrink-0 text-mist-400">→ {row.to}</span>
					<span class="ml-auto text-right text-[12.5px] text-mist-400"
						>{row.state === 'failed'
							? row.note
							: row.state === 'waiting' && r.finished
								? 'not sent'
								: STATE_TEXT[row.state]}</span
					>
				</div>
			{/each}
		</div>
		{#if r.finished && r.stopped}
			<p class="note text-danger">Stopped: {r.stopped}</p>
		{/if}
		{#if r.finished && runMoved < r.rows.length}
			<p class="note">Players not moved stay in the plan, so Save tries them again.</p>
		{/if}
		{#snippet actions()}
			{#if r.finished}
				<button type="button" class="btn btn-primary" onclick={closeRun}>Close</button>
			{:else}
				<button type="button" class="btn" disabled={r.stopping} onclick={closeRun}
					>{r.stopping ? 'Stopping…' : 'Stop the rest'}</button
				>
			{/if}
		{/snippet}
	</Modal>
{/if}
