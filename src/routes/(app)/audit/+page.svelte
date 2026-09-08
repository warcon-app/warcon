<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, errorMessage, qs } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import type { AuditRow } from '$lib/server/audit';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let extra = $state<AuditRow[]>([]);
	let nextBefore = $state<number | null>(null);
	let loadingMore = $state(false);
	// Reset the appended pages whenever the server-loaded page changes.
	$effect(() => {
		data.entries;
		extra = [];
		nextBefore = data.nextBefore;
	});
	let rows = $derived([...data.entries, ...extra]);

	const toLocal = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
	let f = $state({ server: '', actor: '', action: '', outcome: '', q: '', from: '', to: '' });
	$effect(() => {
		const d = data.filters;
		f = {
			server: d.serverId || '',
			actor: d.actorId || '',
			action: d.action || '',
			outcome: d.outcome || '',
			q: d.q || '',
			from: toLocal(d.from),
			to: toLocal(d.to)
		};
	});

	const query = () => ({
		server: f.server,
		actor: f.actor,
		action: f.action,
		outcome: f.outcome,
		q: f.q.trim(),
		from: f.from ? new Date(f.from).toISOString() : '',
		to: f.to ? new Date(f.to).toISOString() : ''
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	function apply() {
		void goto(`/audit${qs(query())}`, { keepFocus: true, noScroll: true, replaceState: true });
	}
	function applyDebounced() {
		clearTimeout(timer);
		timer = setTimeout(apply, 300);
	}
	async function more() {
		if (!nextBefore) return;
		loadingMore = true;
		try {
			const d = await api<{ entries: AuditRow[]; nextBefore: number | null }>(
				'GET',
				`/api/audit${qs({ ...query(), before: nextBefore, limit: 100 })}`
			);
			extra.push(...d.entries);
			nextBefore = d.nextBefore;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			loadingMore = false;
		}
	}
	const exportUrl = (format: string) => `/api/audit/export${qs({ ...query(), format })}`;
	const outcomeClass = (o: string) =>
		o === 'ok' ? 'text-ok' : o === 'denied' ? 'text-warn' : 'text-danger';
</script>

<svelte:head><title>Audit trail · {data.appName}</title></svelte:head>

<h1 class="mb-5 text-xl font-semibold tracking-tight">Audit trail</h1>

<div class="mb-4 panel">
	<div class="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
		<select class="input" bind:value={f.server} onchange={apply} aria-label="Server">
			<option value="">All servers</option>
			{#each data.servers as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
		</select>
		<select class="input" bind:value={f.actor} onchange={apply} aria-label="Actor">
			<option value="">All actors</option>
			{#each data.actors as a (a.actorId)}<option value={a.actorId}
					>{a.actorName || a.actorId}</option
				>{/each}
		</select>
		<select class="input" bind:value={f.action} onchange={apply} aria-label="Action">
			<option value="">All actions</option>
			{#each data.actions as a (a.action)}<option value={a.action}>{a.category} · {a.action}</option
				>{/each}
		</select>
		<select class="input" bind:value={f.outcome} onchange={apply} aria-label="Outcome">
			<option value="">All outcomes</option>
			<option value="ok">ok</option>
			<option value="error">error</option>
			<option value="denied">denied</option>
		</select>
		<input
			class="col-span-2 input"
			type="search"
			placeholder="Search target, message, detail, IP…"
			bind:value={f.q}
			oninput={applyDebounced}
		/>
		<input class="input" type="datetime-local" title="From" bind:value={f.from} onchange={apply} />
		<input class="input" type="datetime-local" title="To" bind:value={f.to} onchange={apply} />
	</div>
	<div class="mt-3 flex flex-wrap items-center gap-3">
		<span class="text-[12.5px] text-mist-400">
			{data.user.role === 'owner'
				? 'Every login, user change, server change and game-server command, panel-wide.'
				: 'Your own actions, plus everything on servers where you are an admin.'}
		</span>
		<span class="ml-auto flex items-center gap-2">
			<span class="text-[12.5px] text-mist-600"
				>{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}{nextBefore
					? ' (more available)'
					: ''}</span
			>
			<a class="btn btn-sm" href={exportUrl('csv')} target="_blank" rel="noopener">Export CSV</a>
			<a class="btn btn-sm" href={exportUrl('json')} target="_blank" rel="noopener">Export JSON</a>
		</span>
	</div>
</div>

<div class="table-wrap">
	<table>
		<thead>
			<tr
				><th>Time</th><th>Actor</th><th>Server</th><th>Action</th><th>Target</th><th>Outcome</th><th
					>Message / detail</th
				><th>IP</th><th class="num">ms</th></tr
			>
		</thead>
		<tbody>
			{#each rows as r (r.id)}
				<tr>
					<td class="font-mono text-[12px] whitespace-nowrap" title={String(r.ts)}
						>{fmtTime(r.ts)}</td
					>
					<td
						>{#if r.actorName}{r.actorName}{:else}<span class="text-mist-600">—</span>{/if}</td
					>
					<td
						>{#if r.serverName}{r.serverName}{:else}<span class="text-mist-600">—</span>{/if}</td
					>
					<td><span class="chip">{r.action}</span></td>
					<td class="font-mono text-[12px]">{r.target}</td>
					<td class="font-semibold whitespace-nowrap {outcomeClass(r.outcome)}"
						>{r.outcome.toUpperCase()}{r.status ? ` ${r.status}` : ''}</td
					>
					<td class="max-w-[420px]">
						{#if r.message}<div>{r.message}</div>{/if}
						{#if r.detail && Object.keys(r.detail as object).length}
							<details class="text-[12px] text-mist-400">
								<summary class="cursor-pointer">detail</summary>
								<pre
									class="mt-1 max-h-60 overflow-auto rounded-ctl bg-black/40 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-mist-100">{JSON.stringify(
										r.detail,
										null,
										2
									)}</pre>
							</details>
						{/if}
					</td>
					<td class="font-mono text-[12px] text-mist-400">{r.ip}</td>
					<td class="num font-mono text-[12px] text-mist-600">{r.durationMs ?? ''}</td>
				</tr>
			{:else}
				<tr><td colspan="9" class="py-8 text-center text-mist-600">No audit entries match.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
{#if nextBefore}
	<div class="mt-4 text-center">
		<button class="btn" onclick={more} disabled={loadingMore}
			>{loadingMore ? 'Loading…' : 'Load more'}</button
		>
	</div>
{/if}
{#if page.url.searchParams.size}
	<div class="mt-3 text-center">
		<a href="/audit" class="text-[12.5px] text-mist-400 underline">Clear filters</a>
	</div>
{/if}
