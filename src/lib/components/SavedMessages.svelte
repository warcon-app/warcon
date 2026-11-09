<script lang="ts">
	// A chat box with the organisation's saved messages beside it: the box's label, a toggle on the
	// same row that opens a searchable list under the box, and the box itself (children). Picking
	// a message puts its text in the box, to send or change first; nothing is sent from here.
	// The toggle shows to whoever may chat on the server when there is something to pick, and to
	// owners, who can add some, when there is not.
	import { tick, type Snippet } from 'svelte';
	import { savedMessagesOn } from '$lib/saved-messages-load';
	import { findSaved, type SavedMessage } from '$lib/saved-messages';
	import type { ServerInfo } from '$lib/types';

	let {
		server,
		label,
		labelFor,
		inputId,
		value,
		onpick,
		send = 'Send',
		enabled = true,
		children
	}: {
		/** the server the box chats on; its organisation's list is the one offered */
		server: Pick<ServerInfo, 'id' | 'orgId' | 'orgName' | 'manager'>;
		/** the box's label, and the field it names */
		label: string;
		labelFor: string;
		/** the box a pick fills, which then takes the focus */
		inputId: string;
		/** what the box holds: the message it matches is marked in the list */
		value: string;
		onpick: (text: string) => void;
		/** what the button that sends says, for the line under the list */
		send?: string;
		/** may the person chat here? Without it there is nothing to read or pick */
		enabled?: boolean;
		children: Snippet;
	} = $props();

	/** From this many on, the list opens with a search box. */
	const SEARCH_FROM = 6;
	const listId = $props.id();

	/** the org's Messages tab, for its owners (and the site owner), who write the list */
	let editHref = $derived(
		server.manager ? `/orgs/${encodeURIComponent(server.orgId)}/messages` : null
	);

	let list = $state<SavedMessage[] | null>(null);
	let open = $state(false);
	let query = $state('');
	let toggleEl = $state<HTMLButtonElement>();
	let listEl = $state<HTMLDivElement>();

	$effect(() => {
		if (!enabled) {
			list = null;
			return;
		}
		let gone = false;
		savedMessagesOn(server.id).then(
			(l) => {
				if (!gone) list = l;
			},
			() => {
				if (!gone) list = null;
			}
		);
		return () => {
			gone = true;
		};
	});

	let shown = $derived(!!list && (list.length > 0 || !!editHref));
	let found = $derived(list ? findSaved(list, query) : []);
	let searchable = $derived((list?.length ?? 0) >= SEARCH_FROM);

	const items = () => [...(listEl?.querySelectorAll<HTMLElement>('[data-pick]') ?? [])];

	async function toggle() {
		open = !open;
		query = '';
		if (!open) return;
		await tick();
		(listEl?.querySelector<HTMLElement>('input[type=search]') ?? items()[0])?.focus();
	}

	function close() {
		open = false;
		query = '';
		toggleEl?.focus();
	}

	async function pick(m: SavedMessage) {
		onpick(m.text);
		open = false;
		query = '';
		// the box now holds the text: the caret goes to its end, ready to send or change
		await tick();
		const box = document.getElementById(inputId) as HTMLInputElement | null;
		box?.focus();
		box?.setSelectionRange(box.value.length, box.value.length);
	}

	/** Escape closes the list (and not a dialog around it); the arrows walk it. */
	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const all = items();
		if (!all.length) return;
		e.preventDefault();
		const at = all.indexOf(document.activeElement as HTMLElement);
		const next = e.key === 'ArrowDown' ? at + 1 : at < 0 ? all.length - 1 : at - 1;
		all[Math.max(0, Math.min(all.length - 1, next))].focus();
	}

	/** Enter in the search takes the first match, and never sends the form around it. */
	function onsearchkey(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		if (found.length) void pick(found[0]);
	}
</script>

<div class="mb-1.5 flex min-h-5 items-center justify-between gap-3">
	<label class="field-label mb-0!" for={labelFor}>{label}</label>
	{#if shown && list}
		<!-- data-close: in a dialog the box still takes the focus on open, not this toggle -->
		<button
			type="button"
			class="inline-flex cursor-pointer items-center gap-1.5 caps transition hover:text-mist-100 {open
				? 'text-mist-100'
				: 'text-mist-400'}"
			aria-expanded={open}
			aria-controls={listId}
			data-close
			bind:this={toggleEl}
			onclick={toggle}
			>Saved messages{list.length ? ` · ${list.length}` : ''}<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				aria-hidden="true"><path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg
			></button
		>
	{/if}
</div>
{@render children()}
{#if open && shown && list}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id={listId}
		class="mt-2 rounded-card border border-black bg-ink-950"
		bind:this={listEl}
		{onkeydown}
	>
		{#if searchable}
			<div class="border-b border-white/8 p-2">
				<input
					class="input py-1.5 text-[13px]"
					type="search"
					placeholder="Find a saved message…"
					aria-label="Find a saved message"
					bind:value={query}
					onkeydown={onsearchkey}
				/>
			</div>
		{/if}
		{#if found.length}
			<div class="max-h-[316px] overflow-y-auto p-1">
				{#each found as m (m.name)}
					<button
						type="button"
						class="menu-item {m.text === value.trim() ? 'border-accent! bg-accent/10' : ''}"
						data-pick
						onclick={() => pick(m)}
						><span class="block min-w-0"
							><span class="block font-medium">{m.name}</span><span
								class="line-clamp-2 block text-[12.5px] text-mist-400">{m.text}</span
							></span
						></button
					>
				{/each}
			</div>
		{:else}
			<p class="px-3 py-2.5 text-[12.5px] text-mist-400">
				{list.length
					? 'No saved message has that in its name or text.'
					: `${server.orgName} has no saved messages yet.`}
			</p>
		{/if}
		<div
			class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-white/8 px-3 py-2 text-[12px] text-mist-600"
		>
			<span>Picking one fills the box. Nothing goes out until {send}.</span>
			{#if editHref}
				<a href={editHref} class="text-accent hover:underline"
					>{list.length ? 'Edit saved messages' : 'Add saved messages'}</a
				>
			{:else}
				<span>Written by the owners of {server.orgName}</span>
			{/if}
		</div>
	</div>
{/if}
