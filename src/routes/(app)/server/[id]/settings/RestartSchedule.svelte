<script lang="ts">
	// When the game restarts this server (a section of the Settings tab, org owners only). The
	// header's restart countdown, the status cards' "Restarts after this round" and the Restart
	// notice rule all follow it. Hosts differ: the game's own restart after so many hours up, or
	// a daily restart at a time the host lets the owner pick. Either way the round then in
	// progress finishes first.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import {
		describeRestartSchedule,
		MAX_RESTART_HOURS,
		RESTART_AFTER_HOURS,
		restartScheduleOf,
		type RestartSchedule
	} from '$lib/uptime';
	import type { ServerInfo } from '$lib/types';

	let { data }: { data: { server: ServerInfo } } = $props();
	let busy = $state(false);

	const browserZone = (() => {
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
		} catch {
			return 'UTC';
		}
	})();
	const zones: string[] = (() => {
		try {
			return (
				(Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
					'timeZone'
				) ?? []
			);
		} catch {
			return [];
		}
	})();

	// The form starts from what is saved, and again whenever that changes.
	let current = $derived(restartScheduleOf(data.server.restartSchedule));
	let kind = $state<RestartSchedule['kind']>('uptime');
	let hours = $state(RESTART_AFTER_HOURS);
	let time = $state('07:00');
	let timeZone = $state(browserZone);
	$effect(() => {
		const s = current;
		kind = s.kind;
		if (s.kind === 'uptime') hours = s.hours;
		if (s.kind === 'daily') {
			time = s.time;
			timeZone = s.timeZone;
		}
	});

	let wanted = $derived<RestartSchedule>(
		kind === 'uptime'
			? { kind, hours: Number(hours) }
			: kind === 'daily'
				? { kind, time, timeZone: timeZone.trim() }
				: { kind }
	);
	let changed = $derived(JSON.stringify(wanted) !== JSON.stringify(current));

	async function save(schedule: RestartSchedule | null) {
		busy = true;
		try {
			await api('PATCH', `/api/servers/${encodeURIComponent(data.server.id)}`, {
				restartSchedule: schedule
			});
			toast(
				schedule
					? `Restart schedule: ${describeRestartSchedule(schedule)}.`
					: 'Restart schedule back to the game default.',
				'ok'
			);
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
		When this server restarts on its own. WARDOGS restarts a server after {RESTART_AFTER_HOURS} hours
		up; some hosts instead restart it every day at a time you pick in their panel (BisectHosting does).
		Either way the round in progress finishes first. The header's countdown, the status cards and the
		Restart notice rule follow this.
	</p>
	{#if !data.server.manager}
		<p class="note">
			Restarts {describeRestartSchedule(current)}. Only an owner of {data.server.orgName} can change this.
		</p>
	{:else}
		<div class="space-y-3">
			<label class="flex items-center gap-2 text-[14px]">
				<input type="radio" bind:group={kind} value="uptime" disabled={busy} />
				<span>After</span>
				<input
					class="input w-20 text-right"
					type="number"
					min="1"
					max={MAX_RESTART_HOURS}
					step="1"
					bind:value={hours}
					disabled={busy || kind !== 'uptime'}
					aria-label="Hours up"
				/>
				<span>hours up</span>
			</label>
			<label class="flex flex-wrap items-center gap-2 text-[14px]">
				<input type="radio" bind:group={kind} value="daily" disabled={busy} />
				<span>Daily at</span>
				<input
					class="input w-28"
					type="time"
					bind:value={time}
					disabled={busy || kind !== 'daily'}
					aria-label="Time of day"
				/>
				<input
					class="input w-full sm:w-64"
					type="text"
					list="restart-zones"
					bind:value={timeZone}
					disabled={busy || kind !== 'daily'}
					placeholder="America/Chicago"
					autocomplete="off"
					spellcheck="false"
					aria-label="Time zone"
				/>
				<datalist id="restart-zones">
					{#each zones as z (z)}<option value={z}></option>{/each}
				</datalist>
			</label>
			<p class="pl-6 text-[12.5px] text-mist-400">
				The time and zone your host's panel shows, e.g. 07:00 America/Chicago. Daylight saving is
				followed.
			</p>
			<label class="flex items-center gap-2 text-[14px]">
				<input type="radio" bind:group={kind} value="none" disabled={busy} />
				<span>No scheduled restart</span>
			</label>
			<div class="flex flex-wrap items-center gap-2">
				<button
					type="button"
					class="btn btn-primary"
					disabled={busy || !changed}
					onclick={() => save(wanted)}>Save</button
				>
				{#if data.server.restartSchedule}
					<button type="button" class="btn" disabled={busy} onclick={() => save(null)}
						>Use the game default</button
					>
				{:else}
					<Badge>game default</Badge>
				{/if}
			</div>
		</div>
	{/if}
</div>
