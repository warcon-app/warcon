<script lang="ts">
	import { ApiError, errorMessage, rconGet, rconPost } from '$lib/api';
	import { can } from '$lib/capabilities';
	import { chatAfter, mergeChat, type ChatMessage, type ChatPage, type ChatTerms } from '$lib/chat';
	import { watchLive } from '$lib/live';
	import { poll } from '$lib/poll';
	import { matches } from '$lib/table.svelte';
	import { toast } from '$lib/toast.svelte';
	import FactionChip from '$lib/components/FactionChip.svelte';
	import type { Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	// Accepting the terms is saved in the server's config, so it takes Config & settings.
	let mayAccept = $derived(can(data.server.caps, 'config.apply'));

	let terms = $state<ChatTerms | null>(null);
	let lines = $state<ChatMessage[]>([]);
	let loaded = $state(false);
	/** a build before Season 3 has no chat routes */
	let unsupported = $state(false);
	let accepting = $state(false);
	let search = $state('');
	let channel = $state('');
	let status = $state<Status | null>(null);

	let channels = $derived([...new Set(lines.map((m) => m.channel).filter(Boolean))].sort());
	let rows = $derived(
		lines.filter(
			(m) =>
				(!channel || m.channel === channel) &&
				matches(search, m.realName, m.hiddenName, m.steamId, m.text)
		)
	);

	// The terms are read until they are accepted; after that each look reads only the new lines.
	async function refresh() {
		try {
			if (!terms?.accepted) {
				terms = await rconGet<ChatTerms>(id, 'chatTerms');
				if (!terms.accepted) return;
			}
			const page = await rconGet<ChatPage>(id, 'chat', { after: chatAfter(lines) });
			// null: a new map, whose numbering started again, so read it from the start.
			lines =
				mergeChat(lines, page) ?? (await rconGet<ChatPage>(id, 'chat', { after: 0 })).messages;
			loaded = true;
		} catch (err) {
			if (err instanceof ApiError && err.code === 'no_route') unsupported = true;
			else toast(errorMessage(err), 'err');
		}
	}
	$effect(() => poll(() => (unsupported ? undefined : refresh()), 5000));

	async function accept() {
		if (!terms) return;
		accepting = true;
		try {
			const r = await rconPost<{ message?: string }>(id, 'chatTermsAccept', {
				version: terms.requiredVersion
			});
			toast(r?.message || 'Chat terms accepted.', 'ok');
			// The next look reads the terms again, then the chat.
			terms = null;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			accepting = false;
		}
	}

	// Faction colours come from the scoreboard, as on the other tabs.
	$effect(() => {
		void id;
		return watchLive([id], (v) => {
			if (v.status) status = v.status;
		});
	});

	// Newest at the bottom: follow new lines while the view is scrolled to the end.
	let box = $state<HTMLElement>();
	let stick = true;
	const onScroll = () => {
		if (box) stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
	};
	$effect(() => {
		void rows.length;
		if (box && stick) box.scrollTop = box.scrollHeight;
	});

	const dossier = (steamId: string) =>
		`/server/${encodeURIComponent(id)}/players/${encodeURIComponent(steamId)}`;
	const timeOf = (iso: string) => {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
	};
</script>

{#if unsupported}
	<div class="callout">
		This server's build has no in-game chat routes. Chat came with Season 3.
	</div>
{:else if terms && !terms.accepted}
	<div class="max-w-3xl panel">
		<h2 class="text-lg font-semibold tracking-tight">Chat terms</h2>
		<p class="mt-3 whitespace-pre-line text-mist-200">{terms.text}</p>
		{#if mayAccept}
			<div class="mt-4 flex flex-wrap items-center gap-3">
				<button class="btn btn-primary" disabled={accepting} onclick={accept}
					>Accept the terms (version {terms.requiredVersion})</button
				>
			</div>
			<p class="note">
				The game server keeps the acceptance in its config, so it holds for everyone who reads this
				server's chat, here or in any other tool.
			</p>
		{:else}
			<p class="note">
				The server's chat cannot be read until someone who may change its config and settings
				accepts these terms.
			</p>
		{/if}
	</div>
{:else}
	<div class="panel">
		<div class="mb-3 flex flex-wrap items-center gap-3">
			<input
				class="input w-full sm:w-64"
				type="search"
				placeholder="Filter by player or text…"
				aria-label="Filter chat by player or text"
				bind:value={search}
			/>
			<select class="input w-36" aria-label="Filter by channel" bind:value={channel}>
				<option value="">Every channel</option>
				{#each channels as c (c)}<option value={c}>{c}</option>{/each}
			</select>
			<span class="ml-auto text-[12.5px] text-mist-600"
				>{search.trim() || channel ? `${rows.length} of ` : ''}{lines.length}
				{lines.length === 1 ? 'line' : 'lines'} this map (newest last)</span
			>
		</div>
		<div class="max-h-[65vh] table-wrap overflow-y-auto" bind:this={box} onscroll={onScroll}>
			<table>
				<thead><tr><th>Time</th><th>Channel</th><th>Player</th><th>Message</th></tr></thead>
				<tbody>
					{#each rows as m, i (i)}
						<tr>
							<td class="font-mono text-[12px] whitespace-nowrap text-mist-400" title={m.sentUtc}
								>{timeOf(m.sentUtc)}</td
							>
							<td class="whitespace-nowrap"><span class="chip">{m.channel}</span></td>
							<td class="whitespace-nowrap">
								{#if /^\d{17}$/.test(m.steamId)}
									<a
										href={dossier(m.steamId)}
										data-sveltekit-preload-data="tap"
										class="hover:text-accent hover:underline">{m.realName || m.steamId}</a
									>
								{:else}{m.realName}{/if}
								{#if m.hiddenName && m.hiddenName !== m.realName}<span
										class="text-mist-600"
										title="The name other players see">as {m.hiddenName}</span
									>{/if}
								{#if m.faction}<span class="ml-1.5 text-[12px]"
										><FactionChip faction={m.faction} scores={status?.scores} /></span
									>{/if}
							</td>
							<td
								class="max-w-[560px] break-words"
								title={m.rawText && m.rawText !== m.text ? `As typed: ${m.rawText}` : undefined}
								>{m.text}</td
							>
						</tr>
					{:else}
						<tr
							><td colspan="4" class="py-6 text-center text-mist-600"
								>{!loaded
									? 'Loading…'
									: lines.length
										? 'Nothing matches.'
										: 'Nobody has said anything on this map yet.'}</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note">
			What players said on the current map, as the game server holds it in memory: a new map starts
			it empty. Warcon does not store chat; it is read from the server while this page is open.
		</p>
	</div>
{/if}
