<script lang="ts">
	import { rconGet, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { toast } from '$lib/toast.svelte';
	import { matches } from '$lib/table.svelte';
	import type { LogEntry } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	// The peers' addresses come blank to everyone else, so the column is theirs alone.
	let siteOwner = $derived(data.user.role === 'owner');

	let tail = $state(50);
	let auto = $state(true);
	let entries = $state<LogEntry[]>([]);
	let loaded = $state(false);
	let search = $state('');
	let rows = $derived(
		entries.filter((e) => matches(search, e.peer, e.sessionId, e.event, e.detail))
	);

	const EVENT_CLASS: Record<string, string> = {
		AUTH_OK: 'text-ok',
		HTTP: 'text-mist-400',
		AUTH_FAIL: 'text-danger',
		REJECT: 'text-danger',
		COMMAND: 'text-warn'
	};

	async function refresh() {
		try {
			const d = await rconGet<{ entries: LogEntry[] }>(id, 'serverLog', { limit: tail });
			entries = [...d.entries].reverse();
			loaded = true;
		} catch (err) {
			// A failed read ends the auto-refresh until it is ticked again: asking every five seconds
			// would show the same error each time and, where the panel is the one refusing (the
			// capability taken away, the stored password rejected), record each refusal.
			auto = false;
			toast(errorMessage(err), 'err');
		}
	}
	$effect(() => poll(() => (auto ? refresh() : undefined), 5000));
</script>

<div class="panel">
	<div class="mb-3 flex flex-wrap items-center gap-3">
		<span class="label-sm mb-0">Tail</span>
		<select class="input w-24" bind:value={tail} onchange={refresh}>
			{#each [25, 50, 100, 200, 500] as n (n)}<option value={n}>{n}</option>{/each}
		</select>
		<label class="inline-flex items-center gap-2 text-[13px]"
			><input type="checkbox" bind:checked={auto} /> Auto-refresh</label
		>
		<button class="btn btn-sm" onclick={refresh}>Refresh</button>
		<input
			class="input w-full sm:w-64"
			type="search"
			placeholder={siteOwner ? 'Filter by peer, event, detail…' : 'Filter by event, detail…'}
			aria-label="Filter log entries"
			bind:value={search}
		/>
		<span class="ml-auto text-[12.5px] text-mist-600"
			>{search.trim() ? `${rows.length} of ` : ''}{entries.length} entries (newest first)</span
		>
	</div>
	<div class="table-wrap">
		<table>
			<thead
				><tr
					><th>Timestamp (UTC)</th>{#if siteOwner}<th>Peer</th>{/if}<th>Session</th><th>Event</th
					><th>Detail</th></tr
				></thead
			>
			<tbody>
				{#each rows as e, i (i)}
					<tr>
						<td class="font-mono text-[12px] whitespace-nowrap">{e.timestampUtc}</td>
						{#if siteOwner}<td class="font-mono text-[12px]">{e.peer}</td>{/if}
						<td class="font-mono text-[12px] text-mist-400">{e.sessionId}</td>
						<td class="font-semibold {EVENT_CLASS[e.event] || ''}">{e.event}</td>
						<td class="max-w-[480px] font-mono text-[12px] break-words">{e.detail}</td>
					</tr>
				{:else}
					<tr
						><td colspan={siteOwner ? 5 : 4} class="py-6 text-center text-mist-600"
							>{!loaded ? 'Loading…' : entries.length ? 'Nothing matches.' : 'No entries.'}</td
						></tr
					>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="note">
		This is the game server's own RCON listener log (GET /v1/audit): connections, authentication and
		commands from every client, including other admin tools. The panel's own audit trail is under
		Audit.
	</p>
</div>
