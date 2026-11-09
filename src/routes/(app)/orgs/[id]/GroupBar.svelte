<script lang="ts">
	// A reserved-slot group's controls, in one bar above its players: whether it is on and where,
	// switching it, its window, its servers, its name, and taking it away.
	import { goto, invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import { describeSync, groupState } from '$lib/lists';
	import Badge from '$lib/components/Badge.svelte';
	import GroupSwitchDialog from './GroupSwitchDialog.svelte';
	import GroupDialog from './GroupDialog.svelte';
	import type { ListSyncSummary, SlotGroupView } from '$lib/types';

	let {
		org,
		group,
		servers
	}: {
		org: { id: string; name: string };
		group: SlotGroupView;
		/** every server of the organisation */
		servers: { id: string; name: string }[];
	} = $props();

	let shown = $derived(groupState(group));
	let path = $derived(
		`/api/orgs/${encodeURIComponent(org.id)}/slot-groups/${encodeURIComponent(group.id)}`
	);
	let where = $derived(
		group.everyServer
			? 'every server'
			: group.servers.length
				? group.servers.map((s) => s.name).join(', ')
				: 'no servers'
	);
	let switching = $state(false);
	let editing = $state<'rename' | 'servers' | null>(null);
	let busy = $state(false);

	/** switch off now, or (a window set for later) on now until the end it was set to */
	async function quick(body: Record<string, unknown>) {
		busy = true;
		try {
			const res = await api<{ group: SlotGroupView; sync: ListSyncSummary }>(
				'PUT',
				`${path}/switch`,
				body
			);
			const now = groupState(res.group).text;
			toast(
				res.sync.servers.length
					? describeSync(res.sync, `${group.name}: ${now}.`)
					: `${group.name}: ${now}.`,
				'ok',
				8000
			);
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (
			!(await confirmDialog(
				`Remove ${group.name}? It is switched off for good and its name is free again; its players and history stay in the audit trail. Live servers keep its slots until their next restart.`,
				{ okLabel: 'Remove group', danger: true }
			))
		)
			return;
		busy = true;
		try {
			const res = await api<{ sync: ListSyncSummary }>('DELETE', path);
			toast(
				res.sync.servers.length
					? describeSync(res.sync, `${group.name} removed.`)
					: `${group.name} removed.`,
				'ok',
				8000
			);
			await goto(`/orgs/${encodeURIComponent(org.id)}/reserved`, { invalidateAll: true });
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2.5 panel">
	<div class="flex min-w-0 flex-wrap items-center gap-2.5">
		<Badge tone={shown.tone}>{shown.text}</Badge>
		<span class="text-[13px]"
			>{shown.kind === 'off' ? 'for' : 'on'} <b>{where}</b>{#if group.leaving}<span
					class="text-mist-400"
					>, {group.leaving} slot{group.leaving === 1 ? '' : 's'} running until restart</span
				>{/if}</span
		>
	</div>
	<div class="flex flex-wrap items-center gap-1.5 sm:ml-auto">
		{#if shown.kind === 'on'}
			<button class="btn btn-sm" disabled={busy} onclick={() => quick({ on: false })}
				>Switch off</button
			>
			<button class="btn btn-sm" disabled={busy} onclick={() => (switching = true)}>Change…</button>
		{:else if shown.kind === 'later'}
			<button
				class="btn btn-sm"
				disabled={busy}
				onclick={() => quick({ on: true, until: group.onUntil })}>Switch on now</button
			>
			<button class="btn btn-sm" disabled={busy} onclick={() => (switching = true)}>Change…</button>
		{:else}
			<button class="btn btn-sm" disabled={busy} onclick={() => (switching = true)}
				>Switch on…</button
			>
		{/if}
		<span class="mx-1 hidden h-[22px] w-px bg-white/8 sm:block" aria-hidden="true"></span>
		<button class="btn btn-sm" disabled={busy} onclick={() => (editing = 'servers')}
			>Servers…</button
		>
		<button class="btn btn-sm" disabled={busy} onclick={() => (editing = 'rename')}>Rename</button>
		<button class="btn btn-sm btn-danger" disabled={busy} onclick={remove}>Remove</button>
	</div>
</div>

{#if switching}
	<GroupSwitchDialog orgId={org.id} {group} onclose={() => (switching = false)} />
{/if}
{#if editing}
	<GroupDialog {org} {servers} {group} mode={editing} onclose={() => (editing = null)} />
{/if}
