<script lang="ts">
	// When this server restarts on its own (a section of the Settings tab), and for org owners a UTC
	// time of their own, used instead of the game's.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { identity, type Identity } from '$lib/health.svelte';
	import { describeRestartSchedule, restartScheduleOf } from '$lib/uptime';
	import type { ServerInfo } from '$lib/types';

	let { data }: { data: { server: ServerInfo; identity: Identity } } = $props();
	let busy = $state(false);
	let ident = $derived(identity[data.server.id] ?? data.identity);
	let schedule = $derived(restartScheduleOf(data.server.restartSchedule, ident.restartTimeUtc));

	let saved = $derived(data.server.restartSchedule?.time ?? null);
	let own = $state(false);
	let time = $state('07:00');
	$effect(() => {
		own = saved !== null;
		if (saved) time = saved;
	});
	let changed = $derived(own ? time !== saved : saved !== null);

	async function save() {
		busy = true;
		try {
			await api('PATCH', `/api/servers/${encodeURIComponent(data.server.id)}`, {
				restartSchedule: own ? { time } : null
			});
			toast('Restart time saved.', 'ok');
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<div class="panel">
	<span class="label-sm">Game restart</span>
	<p class="mb-4 text-[13px] text-mist-400">
		Restarts {describeRestartSchedule(schedule)}; the round in progress finishes first.
	</p>
	{#if !data.server.manager}
		<p class="note">Only an owner of {data.server.orgName} can change this.</p>
	{:else}
		<div class="space-y-3">
			<label class="flex items-center gap-2 text-[14px]">
				<input type="checkbox" bind:checked={own} disabled={busy} />
				<span>Set the restart time myself</span>
			</label>
			{#if own}
				<div class="flex flex-wrap items-center gap-2 pl-6 text-[14px]">
					<span>Daily at</span>
					<input
						class="input w-28"
						type="time"
						bind:value={time}
						disabled={busy}
						aria-label="Time of day, UTC"
					/>
					<span>UTC</span>
				</div>
			{/if}
			<button
				type="button"
				class="btn btn-primary"
				disabled={busy || !changed || (own && !time)}
				onclick={save}>Save</button
			>
		</div>
	{/if}
</div>
