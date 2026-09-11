<script lang="ts">
	import { rconGet, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { toast } from '$lib/toast.svelte';
	import type { LogEntry } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);

	let tail = $state(50);
	let auto = $state(true);
	let entries = $state<LogEntry[]>([]);
	let loaded = $state(false);

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
		<span class="ml-auto text-[12.5px] text-mist-600">{entries.length} entries (newest first)</span>
	</div>
	<div class="table-wrap">
		<table>
			<thead
				><tr><th>Timestamp (UTC)</th><th>Peer</th><th>Session</th><th>Event</th><th>Detail</th></tr
				></thead
			>
			<tbody>
				{#each entries as e, i (i)}
					<tr>
						<td class="font-mono text-[12px] whitespace-nowrap">{e.timestampUtc}</td>
						<td class="font-mono text-[12px]">{e.peer}</td>
						<td class="font-mono text-[12px] text-mist-400">{e.sessionId}</td>
						<td class="font-semibold {EVENT_CLASS[e.event] || ''}">{e.event}</td>
						<td class="max-w-[480px] font-mono text-[12px] break-words">{e.detail}</td>
					</tr>
				{:else}
					<tr
						><td colspan="5" class="py-6 text-center text-mist-600"
							>{loaded ? 'No entries.' : 'Loading…'}</td
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
