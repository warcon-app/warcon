<script lang="ts">
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { api, errorMessage, qs } from '$lib/api';
	import { fmtNum, fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import type { FeedEventView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	const PAGE = 100;
	let eventType = $state(page.url.searchParams.get('type') ?? '');
	let events = $state<FeedEventView[]>([]);
	let total = $state<number | null>(null);
	let configured = $state<boolean | null>(null);
	let loading = $state(false);
	let more = $state(false);
	let seq = 0;

	async function load(append = false) {
		const my = ++seq;
		const last = append ? events[events.length - 1] : undefined;
		loading = true;
		try {
			const result = await api<{
				configured: boolean;
				events: FeedEventView[];
				total: number | null;
			}>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/events${qs({
					type: eventType.trim(),
					limit: PAGE,
					before: last?.ts,
					beforeId: last?.eventId,
					count: append ? '' : '1'
				})}`
			);
			if (my !== seq) return;
			configured = result.configured;
			if (last) {
				const known = new Set(events.map((e) => `${e.ts}:${e.eventId}`));
				events = [...events, ...result.events.filter((e) => !known.has(`${e.ts}:${e.eventId}`))];
			} else {
				events = result.events;
				total = result.total;
			}
			more = result.events.length === PAGE;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			if (my === seq) loading = false;
		}
	}

	let first = true;
	$effect(() => {
		const type = eventType.trim();
		const immediate = first;
		first = false;
		const timer = setTimeout(
			() => {
				const url = new URL(page.url);
				url.search = qs({ type });
				if (url.search !== page.url.search) replaceState(url, {});
				void load();
			},
			immediate ? 0 : 250
		);
		return () => clearTimeout(timer);
	});

	const payload = (event: FeedEventView) => {
		try {
			return JSON.stringify(event.rawEvent, null, 2) ?? 'null';
		} catch {
			return String(event.rawEvent);
		}
	};
</script>

<div class="panel">
	<div class="mb-3 flex flex-wrap gap-2">
		<input
			class="input min-w-64 grow"
			type="search"
			placeholder="Exact event type, for example killed"
			aria-label="Filter by exact event type"
			bind:value={eventType}
		/>
		<button class="btn" onclick={() => load()} disabled={loading}>
			{loading ? 'Loading…' : 'Refresh'}
		</button>
		{#if eventType}<button class="btn" onclick={() => (eventType = '')}>Clear filter</button>{/if}
	</div>
	<div class="mb-3 flex flex-wrap items-center gap-3 text-[12.5px] text-mist-600">
		<span class="text-mist-200">
			{#if total === null}{loading ? 'Counting…' : ''}{:else}{fmtNum(total)}
				{total === 1 ? 'event' : 'events'}{eventType ? ' match' : ''}{/if}
		</span>
		<span class="ml-auto">newest first · refresh to fetch newly ingested events</span>
	</div>
	<div class="table-wrap">
		<table>
			<thead>
				<tr><th>When</th><th>Type</th><th>Match</th><th>Map</th><th>Raw event</th></tr>
			</thead>
			<tbody>
				{#each events as event (`${event.ts}:${event.eventId}`)}
					<tr>
						<td class="font-mono text-[12px] whitespace-nowrap text-mist-400">
							{fmtTime(event.ts)}
						</td>
						<td class="whitespace-nowrap">
							<button
								type="button"
								class="chip cursor-pointer hover:text-accent"
								title="Show only this event type"
								onclick={() => (eventType = event.eventType)}>{event.eventType}</button
							>
							{#if event.eventType === 'killed' && !event.parsedKill}
								<span class="chip text-warn">incomplete</span>
							{/if}
						</td>
						<td>
							<div>{event.eventTime === null ? '—' : `${Math.round(event.eventTime)} s`}</div>
							{#if event.matchId}<div
									class="max-w-48 truncate font-mono text-[11px] text-mist-600"
									title={event.matchId}
								>
									{event.matchId}
								</div>{/if}
						</td>
						<td>{event.map || '—'}</td>
						<td class="min-w-64">
							<details>
								<summary class="cursor-pointer text-accent hover:underline">
									View JSON
									<span class="ml-2 font-mono text-[10px] text-mist-600">{event.eventId}</span>
								</summary>
								<pre
									class="mt-2 max-h-80 overflow-auto rounded-ctl bg-ink-950 p-3 text-[11px] whitespace-pre-wrap text-mist-300">{payload(
										event
									)}</pre>
							</details>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="5" class="py-6 text-center text-mist-600">
							{#if loading}Loading…{:else if configured === false}This server has no event feed yet.
								An org owner turns it on under <a
									href="/server/{encodeURIComponent(id)}/config"
									class="text-accent hover:underline">Config</a
								>.{:else if eventType}No events have this type.{:else}No events received yet. They
								appear here after the game posts them.{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if more}
		<button class="mt-3 btn" onclick={() => load(true)} disabled={loading}>
			{loading ? 'Loading…' : 'Load older events'}
		</button>
	{/if}
	<p class="note">
		Every event accepted by the ingest route, including unknown types and incomplete kill events.
		The original JSON is retained and shown without interpretation.
	</p>
</div>
