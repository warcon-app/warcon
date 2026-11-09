<script lang="ts">
	// The organisation's saved messages: ready-made chat lines for everyone who may chat on its
	// servers, offered beside each chat box. A row per message, its name and its text, saved
	// together in the order the pickers list them. Owners only.
	import { invalidateAll } from '$app/navigation';
	import { tick, untrack } from 'svelte';
	import { api, errorMessage } from '$lib/api';
	import { fmtAgo, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import RowMenu from '$lib/components/RowMenu.svelte';
	import { forgetSavedMessages } from '$lib/saved-messages-load';
	import {
		cleanSavedMessage,
		MAX_SAVED_MESSAGE_NAME,
		MAX_SAVED_MESSAGE_TEXT,
		MAX_SAVED_MESSAGES,
		savedMessagesProblem,
		type SavedMessage
	} from '$lib/saved-messages';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** One message as edited. */
	type Row = { key: number; name: string; text: string };
	let nextKey = 0;
	const rowsOf = (list: SavedMessage[]): Row[] =>
		list.map((m) => ({ key: nextKey++, name: m.name, text: m.text }));

	let rows = $state<Row[]>(untrack(() => rowsOf(data.savedMessages)));
	// Back to what is saved when that changes, not whenever the page reloads its data, which would
	// throw away what is being typed.
	let shown = untrack(() => JSON.stringify(data.savedMessages));
	$effect(() => {
		const now = JSON.stringify(data.savedMessages);
		if (now === shown) return;
		shown = now;
		rows = rowsOf(data.savedMessages);
	});

	/** What Save sends: rows left wholly blank are dropped. */
	let draft = $derived(
		rows
			.filter((r) => r.name.trim() || r.text.trim())
			.map((r) => cleanSavedMessage({ name: r.name, text: r.text }))
	);
	let problem = $derived(savedMessagesProblem(draft));
	let changed = $derived(JSON.stringify(draft) !== JSON.stringify(data.savedMessages));
	let busy = $state(false);
	/** the row whose text is being typed, which shows its length */
	let typing = $state<number | null>(null);
	let list = $state<HTMLDivElement>();

	function move(i: number, by: number) {
		if (i + by < 0 || i + by >= rows.length) return;
		const next = [...rows];
		[next[i], next[i + by]] = [next[i + by], next[i]];
		rows = next;
	}
	async function add() {
		const key = nextKey++;
		rows = [...rows, { key, name: '', text: '' }];
		await tick();
		list?.querySelector<HTMLInputElement>(`[data-row="${key}"] input`)?.focus();
	}
	const remove = (i: number) => (rows = rows.filter((_, j) => j !== i));

	async function save() {
		if (busy || problem || !changed) return;
		busy = true;
		try {
			await api('PATCH', `/api/orgs/${encodeURIComponent(data.org.id)}`, { savedMessages: draft });
			forgetSavedMessages();
			toast('Saved messages updated.', 'ok');
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	/** A message goes out as one line: Enter adds no line break. */
	function oneLine(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.isComposing) e.preventDefault();
	}

	const GRID = 'grid-cols-[minmax(0,1fr)_32px] sm:grid-cols-[240px_minmax(0,1fr)_32px]';
</script>

<div class="panel">
	<span class="label-sm">Saved messages</span>
	<p class="note mt-0 mb-4 max-w-[900px]">
		Ready-made lines for everyone in {data.org.name} who can chat on a server: under Message to on the
		Overview, in a whisper on the Players tab and on a player's page. Picking one fills the box, and they
		can change it before it goes. Sent as written, up to {MAX_SAVED_MESSAGE_TEXT} characters, the most
		the game takes in one line.
	</p>

	<form
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		{#if rows.length}
			<div class="grid {GRID} gap-2">
				<span class="field-label mb-0!">Name</span>
				<span class="field-label mb-0! hidden sm:block">Message</span>
				<span></span>
			</div>
		{:else}
			<p class="text-[13px] text-mist-400">
				No saved messages yet. Add the lines your staff send most: a rules reminder, a restart
				warning, where to find your Discord.
			</p>
		{/if}
		<div bind:this={list}>
			{#each rows as row, i (row.key)}
				<div
					class="grid {GRID} items-start gap-2 border-t border-white/5 py-3 sm:border-0 sm:py-0 sm:pt-2"
					data-row={row.key}
				>
					<input
						class="input"
						type="text"
						aria-label="Name"
						placeholder="Name"
						maxlength={MAX_SAVED_MESSAGE_NAME}
						bind:value={row.name}
					/>
					<!-- The length sits in the box's corner: shown under the box, it moved Save away
					     from under a click that had just left the box. -->
					<div class="relative order-last col-span-2 sm:order-none sm:col-span-1">
						<textarea
							class="block min-h-[58px] input resize-y pr-20"
							rows="2"
							aria-label="Message"
							placeholder="Message"
							maxlength={MAX_SAVED_MESSAGE_TEXT}
							bind:value={row.text}
							onkeydown={oneLine}
							onfocus={() => (typing = row.key)}
							onblur={() => (typing = null)}></textarea>
						{#if typing === row.key}
							<span
								class="pointer-events-none absolute right-5 bottom-1.5 text-[11.5px] text-mist-400 tabular"
								>{row.text.length} / {MAX_SAVED_MESSAGE_TEXT}</span
							>
						{/if}
					</div>
					<RowMenu label="Actions for {row.name || 'this saved message'}">
						{#if i > 0}
							<button type="button" class="menu-item" role="menuitem" onclick={() => move(i, -1)}
								>Move up</button
							>
						{/if}
						{#if i < rows.length - 1}
							<button type="button" class="menu-item" role="menuitem" onclick={() => move(i, 1)}
								>Move down</button
							>
						{/if}
						{#if rows.length > 1}<hr class="my-1 border-black" />{/if}
						<button
							type="button"
							class="menu-item text-danger!"
							role="menuitem"
							onclick={() => remove(i)}>Remove</button
						>
					</RowMenu>
				</div>
			{/each}
		</div>
		<button
			type="button"
			class="mt-3 btn btn-sm"
			disabled={rows.length >= MAX_SAVED_MESSAGES}
			onclick={add}>+ Add a saved message</button
		>
		<div class="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3.5">
			<span class="text-[12.5px] {problem ? 'text-danger' : 'text-mist-400'}">
				{#if problem}
					{problem}
				{:else}
					{draft.length} of {MAX_SAVED_MESSAGES}
					{#if data.savedAt}
						· last saved <span title={fmtTime(data.savedAt)}>{fmtAgo(data.savedAt)}</span>
						{#if data.savedBy}by {data.savedBy}{/if}
					{/if}
				{/if}
			</span>
			<span class="ml-auto inline-flex flex-wrap justify-end gap-2">
				<button
					type="button"
					class="btn btn-ghost"
					disabled={busy || !changed}
					onclick={() => (rows = rowsOf(data.savedMessages))}>Undo changes</button
				>
				<button type="submit" class="btn btn-primary" disabled={busy || !!problem || !changed}
					>Save</button
				>
			</span>
		</div>
	</form>
</div>
