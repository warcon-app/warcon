<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { fmtNum } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	type Setting = (typeof data.settings)[number];
	type Worker = typeof data.worker;

	let refreshed = $state<Worker | null>(null);
	let worker = $derived(refreshed ?? data.worker);
	/** edits by key, in the unit shown (seconds for millisecond settings) */
	let edits = $state<Record<string, string>>({});
	let busy = $state(false);

	const GROUPS: { id: Setting['group']; title: string; blurb: string }[] = [
		{
			id: 'observation',
			title: 'Observation cadence',
			blurb:
				'How often the worker looks at each server. Watched: someone has it open. Busy: people on it. The game listener sets the floor; lower is fresher.'
		},
		{
			id: 'delivery',
			title: 'Trigger delivery',
			blurb: 'How trigger actions are sent and when a late one is dropped instead.'
		},
		{
			id: 'housekeeping',
			title: 'Housekeeping and retention',
			blurb: 'Database writes that are not observations, and how long history is kept.'
		}
	];

	const shown = (s: Setting, v = s.value) => (s.unit === 'ms' ? String(v / 1000) : String(v));
	const unitLabel = (s: Setting) => (s.unit === 'ms' ? 's' : s.unit === 'days' ? 'days' : '');
	const bounds = (s: Setting) =>
		s.unit === 'ms' ? `${s.min / 1000}–${s.max / 1000} s` : `${s.min}–${s.max}`;
	const value = (s: Setting) => (s.key in edits ? edits[s.key] : shown(s));
	const dirty = (s: Setting) => s.key in edits && edits[s.key] !== shown(s);

	async function save() {
		const values: Record<string, number> = {};
		for (const s of data.settings) {
			if (!dirty(s)) continue;
			const n = Number(edits[s.key]);
			if (!Number.isFinite(n)) {
				toast(`${s.label}: not a number.`, 'err');
				return;
			}
			values[s.key] = s.unit === 'ms' ? Math.round(n * 1000) : Math.round(n);
		}
		if (!Object.keys(values).length) return;
		busy = true;
		try {
			await api('PUT', '/api/settings', { values });
			toast('Settings saved; the worker picks them up within ten seconds.', 'ok');
			edits = {};
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function reset(s: Setting) {
		busy = true;
		try {
			await api('PUT', '/api/settings', { reset: [s.key] });
			delete edits[s.key];
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function refreshWorker() {
		try {
			refreshed = (await api<{ worker: Worker }>('GET', '/api/health')).worker;
		} catch {
			/* keep the last view */
		}
	}
	$effect(() => poll(refreshWorker, 5000));
	const secs = (ms: number | null) => (ms === null ? '—' : `${Math.round(ms / 100) / 10}s`);
</script>

<svelte:head><title>Settings · {data.appName}</title></svelte:head>

<h1 class="mb-5 text-xl font-semibold tracking-tight">Settings</h1>

<div class="mb-4 panel">
	<div class="mb-2 flex flex-wrap items-center gap-2">
		<span class="label-sm mb-0">Worker</span>
		{#if worker.owner}<Badge tone="ok">this process holds the lease</Badge
			>{:else if worker.enabled}<Badge tone="warn">another process holds the lease</Badge
			>{:else}<Badge tone="err">not running</Badge>{/if}
		{#if worker.behind}<Badge tone="err">{worker.behind} behind</Badge>{/if}
		{#if worker.stuck}<Badge tone="err">{worker.stuck} stuck</Badge>{/if}
	</div>
	<div class="grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-4">
		<div class="kv">
			<span class="text-mist-400">Servers</span><span>{fmtNum(worker.servers)}</span>
		</div>
		<div class="kv">
			<span class="text-mist-400">Tiers</span><span
				>{worker.tiers.watched} watched · {worker.tiers.hot} busy · {worker.tiers.idle} idle · {worker
					.tiers.offline} unreachable</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">In flight</span><span
				>{worker.active} / {worker.concurrency} · lanes busy {worker.lanes.busy}, queued {worker
					.lanes.queued}</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Deliveries</span><span
				>{worker.delivery.pending} pending{#if worker.delivery.oldestMs !== null}
					(oldest {secs(worker.delivery.oldestMs)}){/if} · {worker.delivery.delivered} delivered · {worker
					.delivery.failed} failed · {worker.delivery.unknown} unknown · {worker.delivery.skipped} skipped</span
			>
		</div>
	</div>
	<p class="note">
		"Behind" counts servers overdue by more than their own cadence: the worker is not keeping up and
		the concurrency guard or the cadences need a look. Everything here is also on
		<code class="chip">/api/health</code>.
	</p>
</div>

{#each GROUPS as g (g.id)}
	<div class="mb-4 panel">
		<span class="label-sm">{g.title}</span>
		<p class="mb-3 text-[13px] text-mist-400">{g.blurb}</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Setting</th><th>Value</th><th>Allowed</th><th></th></tr></thead>
				<tbody>
					{#each data.settings.filter((s) => s.group === g.id) as s (s.key)}
						<tr>
							<td>
								<div class="font-medium">{s.label}</div>
								<div class="text-[12.5px] text-mist-500">{s.help}</div>
							</td>
							<td class="whitespace-nowrap">
								<span class="join">
									<input
										class="input w-28"
										type="number"
										step={s.unit === 'ms' ? 0.5 : 1}
										value={value(s)}
										oninput={(e) => (edits[s.key] = (e.target as HTMLInputElement).value)}
									/>
									<span class="pointer-events-none btn btn-ghost">{unitLabel(s)}</span>
								</span>
								{#if dirty(s)}<Badge tone="warn" class="ml-1">unsaved</Badge>{/if}
							</td>
							<td class="whitespace-nowrap text-mist-500">{bounds(s)}</td>
							<td class="whitespace-nowrap">
								{#if s.stored}
									<button class="btn btn-sm" disabled={busy} onclick={() => reset(s)}
										>Reset to {shown(s, s.default)}{unitLabel(s)}</button
									>
								{:else}<span class="text-[12.5px] text-mist-600">default</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/each}

<div class="flex items-center gap-3">
	<button class="btn btn-primary" disabled={busy || !data.settings.some(dirty)} onclick={save}
		>Save changes</button
	>
	<span class="text-[13px] text-mist-500"
		>Changes are audited and take effect without a restart.</span
	>
</div>
