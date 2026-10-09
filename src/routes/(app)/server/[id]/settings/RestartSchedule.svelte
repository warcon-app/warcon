<script lang="ts">
	// When this server restarts on its own (a section of the Settings tab): what Warcon expects and
	// where that comes from, the next window, and for org owners a UTC time of their own that is used
	// instead. The game decides by default: RestartTimeUtc in its config document as the running
	// process started with it, else 24 hours up; either way the round in progress finishes first.
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import { identity, type Identity } from '$lib/health.svelte';
	import { fmtUptime, restartScheduleOf, restartWindow } from '$lib/uptime';
	import type { ServerInfo } from '$lib/types';

	let { data }: { data: { server: ServerInfo; identity: Identity } } = $props();
	let busy = $state(false);

	let ident = $derived(identity[data.server.id] ?? data.identity);
	let schedule = $derived(restartScheduleOf(data.server.restartSchedule, ident.restartTimeUtc));
	// A change to RestartTimeUtc waits for the next restart; an owner's own time makes it moot.
	let pending = $derived(
		schedule.kind === 'daily' && schedule.source === 'manual'
			? undefined
			: ident.restartTimeUtcFile !== ident.restartTimeUtc
				? ident.restartTimeUtcFile
				: undefined
	);
	let fromConfig = $derived(schedule.kind === 'daily' && schedule.source === 'config');
	let configPage = $derived(`/server/${encodeURIComponent(data.server.id)}/config`);

	// The countdown counts down on its own: a minute clock, only while the page is open.
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	let next = $derived(restartWindow(ident.startedAt, schedule, now));

	const UTC_DAY = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'UTC',
		weekday: 'short',
		day: 'numeric',
		month: 'short'
	});
	const UTC_TIME = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'UTC',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	const LOCAL_DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
	const LOCAL_TIME = new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	/** "Fri 10 Oct, 08:00 UTC (09:00 your time)", the viewer's day named when it is another one. */
	function when(at: number): string {
		const d = new Date(at);
		const sameDay = d.getDate() === d.getUTCDate();
		const local = `${sameDay ? '' : `${LOCAL_DAY.format(d)} `}${LOCAL_TIME.format(d)}`;
		return `${UTC_DAY.format(d)}, ${UTC_TIME.format(d)} UTC (${local} your time)`;
	}
	/** "9 h 30 m" */
	const span = (ms: number) => fmtUptime(ms).replace(/(\d)([a-z])/g, '$1 $2');

	// The form follows the saved time, and only when that changes: another panel's save reloads
	// the page data, which must not throw away an edit here.
	let saved = $derived(data.server.restartSchedule?.time ?? null);
	let own = $state(untrack(() => saved !== null));
	let time = $state(untrack(() => saved ?? '07:00'));
	$effect(() => {
		own = saved !== null;
		if (saved) time = saved;
	});
	let changed = $derived(own ? time !== saved : saved !== null);

	async function save() {
		const body = own ? { time } : null;
		busy = true;
		try {
			await api('PATCH', `/api/servers/${encodeURIComponent(data.server.id)}`, {
				restartSchedule: body
			});
			toast(
				body
					? `Restart time: daily at ${body.time} UTC.`
					: 'The game decides the restart time again.',
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

{#snippet expected()}
	<div
		class="flex items-start gap-2.5 rounded-[6px] bg-[#17171c] px-3.5 py-3 text-[13px] text-[#c9c9cf]"
	>
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			class="mt-0.5 flex-none text-accent"
			><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg
		>
		<div class="flex flex-col gap-1">
			<div class="text-[14px] text-[#e6e6ea]">
				{#if schedule.kind === 'uptime'}
					<span class="font-semibold">After 24 hours up</span>
					<span class="text-[#9a9aa2]"
						>· the game's default; the round in progress finishes first</span
					>
				{:else}
					<span class="font-semibold">Daily at {schedule.time} UTC</span>
					<span class="text-[#9a9aa2]"
						>· {schedule.source === 'manual'
							? 'set here'
							: data.server.manager
								? "from this server's config file (RestartTimeUtc)"
								: "from this server's config file"}; the round in progress finishes first</span
					>
				{/if}
			</div>
			{#if next?.due}
				<div>The restart window is open: the server restarts when this round ends.</div>
			{:else if next}
				<div>Next restart window: {when(next.dueAt)}, in {span(next.untilDueMs ?? 0)}.</div>
			{/if}
			{#if pending !== undefined}
				<div class="text-accent">
					{#if pending}
						Changed in the file to {pending} UTC: the server uses it from its next restart.
					{:else}
						Taken out of the file: the server goes back to 24 hours up from its next restart.
					{/if}
				</div>
			{/if}
			{#if data.server.manager && (fromConfig || pending !== undefined)}
				<div class="text-[#9a9aa2]">
					Set it on the <a class="link" href={configPage}>Config page</a>.
				</div>
			{/if}
		</div>
	</div>
{/snippet}

<div class="panel">
	<span class="label-sm">Game restart</span>
	<p class="mb-4 text-[13px] text-mist-400">
		When this server restarts on its own. The header countdown, the status cards and the Restart
		notice rule follow it.
	</p>
	{#if !data.server.manager}
		{@render expected()}
		<p class="note">Only an owner of {data.server.orgName} can change this.</p>
	{:else}
		<div class="space-y-3">
			{@render expected()}
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
				<p class="pl-6 text-[12.5px] text-mist-400">Used instead of the server's own setting.</p>
			{/if}
			<div class="flex flex-wrap items-center gap-2">
				<button
					type="button"
					class="btn btn-primary"
					disabled={busy || !changed || (own && !time)}
					onclick={save}>Save</button
				>
				{#if saved === null}<Badge>game default</Badge>{/if}
			</div>
		</div>
	{/if}
</div>
