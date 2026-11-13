<script lang="ts">
	// The Automation tab's Chat commands list: a server's chat rules ($lib/rule-kinds CHAT_KINDS), one
	// line each with the words players type first, so thirty commands read as a list and the Rules
	// list keeps to the other rules. A line is still a rule of its own, saved, switched and deleted
	// through the same routes under the same checks: this is only where they are listed. It counts
	// how often a command answered and never says who typed what.
	import {
		byCommand,
		commandRow,
		COMMAND_PREFIX,
		NOT_ANSWERED,
		type CommandRow
	} from '$lib/chat-commands';
	import { fmtAgo, fmtNum, fmtTime } from '$lib/format';
	import { matches } from '$lib/table.svelte';
	import RowMenu from '$lib/components/RowMenu.svelte';
	import type { Snippet } from 'svelte';
	import type { TriggerView } from '$lib/types';

	type ChatKind = 'chat_command' | 'staff_call';

	let {
		rules,
		serverId,
		chat,
		canReadChat,
		staffHooks,
		admin,
		busy,
		dryBusy,
		now,
		lacks,
		starters,
		above,
		onadd,
		onstart,
		onedit,
		ontoggle,
		onremove,
		onpreview
	}: {
		/** the server's chat rules, of both kinds */
		rules: TriggerView[];
		serverId: string;
		/** the server's build serves the in-game chat */
		chat: boolean;
		/** the reader may open the Chat tab, where the game's chat terms are accepted */
		canReadChat: boolean;
		/** how many of the organisation's webhooks would carry a Staff call from this server */
		staffHooks: number;
		admin: boolean;
		busy: boolean;
		dryBusy: boolean;
		/** the page's minute clock */
		now: number;
		/** why the reader cannot save a chat rule here, or '' when they can */
		lacks: string;
		/** the commands a new one can start from; the first few are offered while the list is empty */
		starters: readonly { command: string }[];
		/** what the page shows above the lines: a line's preview opens there, so no line changes height */
		above?: Snippet;
		onadd: (kind: ChatKind) => void;
		/** a new command from the starter at this place in `starters` */
		onstart: (starter: number) => void;
		onedit: (rule: TriggerView, copy?: boolean) => void;
		ontoggle: (rule: TriggerView) => void;
		onremove: (rule: TriggerView) => void;
		onpreview: (rule: TriggerView) => void;
	} = $props();

	const kindOf = (t: TriggerView): ChatKind =>
		t.kind === 'staff_call' ? 'staff_call' : 'chat_command';
	let lines = $derived(
		rules
			.map((rule) => ({ rule, kind: kindOf(rule), row: commandRow(kindOf(rule), rule.config) }))
			.sort(byCommand)
	);
	/** Past this many lines a search over the words and the replies is worth its room. */
	const SEARCH_FROM = 8;
	let searching = $derived(lines.length > SEARCH_FROM);
	let query = $state('');
	// narrowed only while the search shows: a list that shrinks under it is whole again, not left
	// narrowed by a box that is gone
	let shown = $derived(
		searching
			? lines.filter(({ rule, row }) =>
					matches(
						query,
						rule.name,
						row.words.join(' '),
						row.reply,
						Array.isArray(rule.config.replies) ? rule.config.replies.join(' ') : ''
					)
				)
			: lines
	);
	let commands = $derived(rules.filter((t) => t.kind === 'chat_command'));
	let staff = $derived(rules.find((t) => t.kind === 'staff_call'));
	let on = $derived(rules.filter((t) => t.enabled));
	/** "11 commands and a Staff call · 12 on": every line counted, as the tab's switch counts them. */
	let summary = $derived(
		[
			commands.length ? plural(commands.length, 'command') : '',
			staff ? (commands.length ? 'a Staff call' : 'A Staff call') : ''
		]
			.filter(Boolean)
			.join(' and ') + ` · ${on.length} on`
	);

	type Wait = 'build' | 'terms' | 'failing';
	/** What a chat rule waits for before the chat is read for it, as the end of a sentence. */
	const WAITS: Record<Wait, string> = {
		build: "this server's build does not serve the in-game chat",
		terms: "the game's chat terms have not been accepted on this server",
		failing: 'the chat cannot be read right now; commands are answered again once it can'
	};
	/**
	 * What the rules that are on wait for, said once above the list when they all wait for the same
	 * thing: a server's chat is read for all of its rules or for none. Each rule's row holds what the
	 * worker last told it, though, and one switched on while nobody plays still holds what it was
	 * told before it went off; where the rows disagree, each line says its own (`waitOf`) and the
	 * list claims nothing for the rest. A rule the worker has not told anything yet (null) joins the
	 * others. A build that does not serve the chat is the server's, whatever the rows hold.
	 */
	let wait = $derived.by((): Wait | '' => {
		if (!on.length) return '';
		if (!chat) return 'build';
		const told = on
			.map((t) => t.chatWait)
			.filter((w): w is Wait | '' => w !== null && w !== undefined);
		return told.length && told.every((w) => w === told[0]) ? told[0] : '';
	});
	const waitOf = (t: TriggerView): Wait | '' => (!wait && t.enabled && t.chatWait) || '';

	const WHOM = { player: 'the player', everyone: 'everyone', staff: 'staff' } as const;
	/** The wait in full, for the cell that gives it as a number. */
	const waitTitle = (row: CommandRow) =>
		!row.seconds
			? undefined
			: row.to === 'staff'
				? `One player's calls at least ${fmtNum(row.seconds)} s apart`
				: row.to === 'everyone'
					? `The whole server at most once every ${fmtNum(row.seconds)} s`
					: `Each player at most once every ${fmtNum(row.seconds)} s`;
	/** A Staff call in a line: which words call staff, which report a player, and whether it whispers back. */
	const staffAnswer = (row: CommandRow) => {
		const calls = row.words.filter((w) => !row.reports.includes(w));
		return [
			calls.length ? `${calls.join(' ')} to Discord` : '',
			row.reports.length ? `${row.reports.join(' ')} with the player named` : '',
			row.reply ? 'whispers back' : ''
		]
			.filter(Boolean)
			.join(' · ');
	};
	function plural(n: number, one: string) {
		return `${fmtNum(n)} ${one}${n === 1 ? '' : 's'}`;
	}

	// One line on a wide screen, the columns under their headings; on a narrow one the reply and the
	// rest wrap under the words.
	const COLS =
		'grid-cols-[2rem_minmax(0,1fr)_2rem] gap-x-3 gap-y-1 px-4 lg:grid-cols-[2rem_13rem_minmax(0,1fr)_9rem_10.5rem_2rem]';
</script>

<div class="mb-3 flex flex-wrap items-start gap-3">
	<div class="min-w-0 grow">
		<span class="label-sm mb-0">Chat commands</span>
		<div class="mt-0.5 text-[12.5px] text-mist-400">
			{rules.length ? summary : 'No chat commands on this server yet'}
		</div>
	</div>
	{#if searching}
		<input
			class="input w-full sm:w-52"
			type="search"
			placeholder="Find a command…"
			aria-label="Find a command"
			bind:value={query}
		/>
	{/if}
	{#if admin}
		{#if !staff}
			<button type="button" class="btn" onclick={() => onadd('staff_call')}>Add staff call</button>
		{/if}
		<button type="button" class="btn" onclick={() => onadd('chat_command')}>Add command</button>
	{/if}
</div>

{#if wait}
	<div
		class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-ctl border border-warn/30 bg-warn/10 px-3 py-2 text-[13px]"
	>
		<span class="min-w-0 grow basis-105"
			><span class="font-semibold">Nothing is answered for now.</span>
			<span class="text-mist-400">{WAITS[wait][0].toUpperCase() + WAITS[wait].slice(1)}.</span
			></span
		>
		{#if wait === 'terms' && canReadChat}
			<a class="btn btn-sm" href="/server/{encodeURIComponent(serverId)}/chat">Open the Chat tab</a>
		{/if}
	</div>
{/if}
<!-- What the reader lacks to save one, unless the notice above has just said it (the build). -->
{#if admin && lacks && (chat || wait !== 'build')}
	<p class="note mt-0 mb-3 text-warn">{lacks}</p>
{/if}

{@render above?.()}

{#if lines.length}
	<div class="rounded-card border border-black bg-ink-900">
		<!-- For the eye: each cell says what it is to a screen reader in its own words (below). -->
		<div
			class="{COLS} hidden border-b border-black py-2.5 caps text-mist-400 lg:grid"
			aria-hidden="true"
		>
			<span class="col-start-2">Players type</span>
			<span>Answer</span>
			<span>To · wait</span>
			<span>Answered</span>
		</div>
		{#each shown as { rule, kind, row } (rule.id)}
			{@const waits = waitOf(rule)}
			{@const lost = rule.enabled && kind === 'staff_call' && !staffHooks}
			{@const unsent = rule.enabled && rule.lastResult.startsWith(NOT_ANSWERED)}
			<!-- An off line fades its cells, not the line: opacity on the line would fade the ⋯ menu too
			     and trap it under the next one. -->
			{@const dim = rule.enabled ? '' : 'opacity-60'}
			<div class="{COLS} grid items-center border-b border-white/[0.05] py-2.5 last:border-b-0">
				<button
					type="button"
					role="switch"
					aria-checked={rule.enabled}
					aria-label="{rule.name}: {rule.enabled ? 'on' : 'off'}"
					class="col-start-1 row-start-1 h-[18px] w-8 cursor-pointer rounded-full border border-black transition disabled:cursor-not-allowed {rule.enabled
						? 'bg-accent'
						: 'bg-ink-700 opacity-60'}"
					disabled={!admin || busy}
					onclick={() => ontoggle(rule)}
				>
					<span
						class="block h-3 w-3 rounded-full bg-ink-950 transition-transform {rule.enabled
							? 'translate-x-[15px]'
							: 'translate-x-[2px]'}"
					></span>
				</button>
				<div
					class="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 {dim}"
				>
					{#if admin}
						<button
							type="button"
							class="cursor-pointer text-left font-mono text-[13px] font-semibold break-all hover:text-white"
							onclick={() => onedit(rule)}>{row.words[0] ?? rule.name}</button
						>
					{:else}
						<span class="font-mono text-[13px] font-semibold break-all"
							>{row.words[0] ?? rule.name}</span
						>
					{/if}
					{#each row.words.slice(1) as word (word)}
						<span class="chip text-mist-400">{word}</span>
					{/each}
					<!-- The rule's name where it is not the word: the switch, the menu and Delete go by it. -->
					{#if row.words.length && rule.name !== row.words[0]}
						<span class="ml-1 text-[12px] break-words text-mist-600">{rule.name}</span>
					{/if}
				</div>
				<div
					class="col-span-2 col-start-2 row-start-2 flex min-w-0 items-baseline gap-2 text-[13px] lg:col-span-1 lg:col-start-3 lg:row-start-1 {dim}"
				>
					{#if kind === 'staff_call'}
						<span class="line-clamp-2 min-w-0 text-mist-400 lg:line-clamp-1"
							>{staffAnswer(row)}</span
						>
					{:else}
						<span class="line-clamp-2 min-w-0 break-words text-mist-100 lg:line-clamp-1"
							>{row.reply}</span
						>
						{#if row.more}
							<span class="shrink-0 text-[12px] whitespace-nowrap text-mist-600"
								>+{row.more} line{row.more === 1 ? '' : 's'}</span
							>
						{/if}
					{/if}
				</div>
				<div
					class="col-span-2 col-start-2 row-start-3 flex flex-wrap gap-x-3 text-[12.5px] text-mist-400 lg:contents"
				>
					<!-- The words in front stand in for the headings: shown where a narrow screen has no
					     room for those, and kept for a screen reader on a wide one. The spaces sit between
					     the nodes, where they are kept. -->
					<span class="lg:col-start-4 lg:row-start-1 {dim}" title={waitTitle(row)}>
						<span class="lg:sr-only">To</span>
						{WHOM[row.to]}{#if row.seconds}{' · '}<span class="lg:sr-only">wait</span>
							{fmtNum(row.seconds)} s{/if}
					</span>
					<span class="lg:col-start-5 lg:row-start-1 {dim}">
						{#if rule.lastFiredAt}
							<span class="lg:sr-only">{kind === 'staff_call' ? 'Passed on' : 'Answered'}</span>
							{plural(rule.fireCount, kind === 'staff_call' ? 'call' : 'time')} ·
							<span title={fmtTime(rule.lastFiredAt)}>{fmtAgo(rule.lastFiredAt, now)}</span>
						{:else}
							<span class="text-mist-600">Not used yet</span>
						{/if}
					</span>
				</div>
				{#if admin}
					<div class="col-start-3 row-start-1 lg:col-start-6">
						<RowMenu label="Actions for {rule.name}">
							<button
								type="button"
								class="menu-item"
								role="menuitem"
								disabled={dryBusy}
								onclick={() => onpreview(rule)}>Preview what it sends</button
							>
							<button type="button" class="menu-item" role="menuitem" onclick={() => onedit(rule)}
								>Edit</button
							>
							<!-- a server holds one Staff call, so there is no second one to make of it -->
							{#if kind === 'chat_command'}
								<button
									type="button"
									class="menu-item"
									role="menuitem"
									onclick={() => onedit(rule, true)}>Duplicate</button
								>
							{/if}
							<hr class="my-1 border-black" />
							<button
								type="button"
								class="menu-item text-danger!"
								role="menuitem"
								disabled={busy}
								onclick={() => onremove(rule)}>Delete</button
							>
						</RowMenu>
					</div>
				{/if}
				{#if waits || lost || unsent}
					<!-- What this line alone waits for, that its calls reach nobody, or that its last answer
					     did not go out, in the panel's own words. The column start is said again for the wide
					     screen: the span there is a shorthand that would move it. -->
					<p
						class="col-span-2 col-start-2 row-start-4 text-[12px] text-warn lg:col-span-4 lg:col-start-2 lg:row-start-2"
					>
						{#if waits}
							Waiting: {WAITS[waits]}
						{:else if lost}
							No working Discord webhook takes Staff calls for this server, so a call reaches nobody
							· under Organisation → Webhooks an owner ticks the box on one, or mends the one
							Discord refuses
						{:else}
							{rule.lastResult}
						{/if}
					</p>
				{/if}
			</div>
		{:else}
			<p class="px-4 py-6 text-center text-[13px] text-mist-600">
				No command matches “{query.trim()}”.
			</p>
		{/each}
	</div>
{:else}
	<div class="flex flex-col items-center gap-3 panel py-7 text-center">
		{#if admin}
			<p class="text-mist-100">
				Players type <span class="font-mono">{COMMAND_PREFIX}</span> and a word in chat, and the server
				answers with your text.
			</p>
			<div class="flex flex-wrap justify-center gap-2">
				{#each starters.slice(0, 3) as st, i (st.command)}
					<button type="button" class="btn {i ? '' : 'btn-primary'}" onclick={() => onstart(i)}
						>+ <span class="font-mono normal-case">{COMMAND_PREFIX}{st.command}</span></button
					>
				{/each}
			</div>
			<button
				type="button"
				class="cursor-pointer text-[12.5px] text-mist-400 underline decoration-mist-600 underline-offset-[3px] hover:text-mist-100"
				onclick={() => onadd('staff_call')}
				>Or send what follows {COMMAND_PREFIX}admin and {COMMAND_PREFIX}report to your Discord</button
			>
		{:else}
			<p class="text-mist-600">No chat commands on this server yet.</p>
		{/if}
	</div>
{/if}
