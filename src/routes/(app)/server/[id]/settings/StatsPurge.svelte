<script lang="ts">
	// The foot of the Settings tab, org owners only: purge the server's stats. The server's name
	// has to be typed back before the button does anything, and the route checks it again.
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import type { ServerInfo } from '$lib/types';

	let { data }: { data: { server: ServerInfo } } = $props();
	let open = $state(false);
	let typed = $state('');
	let busy = $state(false);
	let done = $state('');
	let named = $derived(typed.trim() === data.server.name);

	async function purge() {
		if (!named || busy) return;
		busy = true;
		try {
			const r = await api<{
				counts: { kills: number; matches: number; matchPlayers: number; matchEvents: number };
			}>('POST', `/api/servers/${encodeURIComponent(data.server.id)}/stats/purge`, {
				name: typed.trim()
			});
			done = `${r.counts.kills} kills, ${r.counts.matches} matches, ${r.counts.matchPlayers} match rows and ${r.counts.matchEvents} match events deleted.`;
			toast('Stats purged.', 'ok');
			open = false;
			typed = '';
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<div class="panel">
	<span class="label-sm">Stats</span>
	<p class="mb-3 text-[13px] text-mist-400">
		Purge this server's stats: every recorded kill, match, match row and match event is deleted, for
		good. Player sessions (who was on, playtime, seed time, first visits) stay. Careers and boards
		for this server start again from the next match; the match in progress is recorded from the
		purge on. The purge is audited.
	</p>
	{#if done}<p class="mb-3 text-[13px] text-ok">{done}</p>{/if}
	{#if !open}
		<button type="button" class="btn btn-danger" onclick={() => (open = true)}>Purge stats…</button>
	{:else}
		<div class="flex flex-wrap items-end gap-2">
			<label class="block">
				<span class="label-sm">Type the server name to confirm</span>
				<input
					class="input w-72 max-w-full"
					type="text"
					bind:value={typed}
					placeholder={data.server.name}
					autocomplete="off"
					spellcheck="false"
				/>
			</label>
			<button type="button" class="btn btn-danger" disabled={!named || busy} onclick={purge}
				>{busy ? 'Purging…' : 'Purge'}</button
			>
			<button
				type="button"
				class="btn"
				disabled={busy}
				onclick={() => {
					open = false;
					typed = '';
				}}>Cancel</button
			>
		</div>
	{/if}
</div>
