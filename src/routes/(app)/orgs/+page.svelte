<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { OrgView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let siteOwner = $derived(data.user.role === 'owner');

	type Dialog =
		{ kind: 'create'; name: string } | { kind: 'suspend'; org: OrgView; reason: string };
	let dialog = $state<Dialog | null>(null);
	let busy = $state(false);

	async function run(fn: () => Promise<void>, done: string) {
		busy = true;
		try {
			await fn();
			toast(done, 'ok');
			dialog = null;
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function create() {
		const d = dialog;
		if (!d || d.kind !== 'create') return;
		busy = true;
		try {
			const res = await api<{ id: string }>('POST', '/api/orgs', { name: d.name.trim() });
			toast('Organisation created.', 'ok');
			dialog = null;
			await invalidateAll();
			await goto(`/orgs/${encodeURIComponent(res.id)}`);
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
	function suspend() {
		const d = dialog;
		if (!d || d.kind !== 'suspend') return;
		void run(
			() =>
				api('PATCH', `/api/orgs/${encodeURIComponent(d.org.id)}`, {
					suspended: true,
					reason: d.reason.trim()
				}),
			`${d.org.name} suspended.`
		);
	}
	function restore(o: OrgView) {
		void run(
			() => api('PATCH', `/api/orgs/${encodeURIComponent(o.id)}`, { suspended: false }),
			`${o.name} restored.`
		);
	}
	async function remove(o: OrgView) {
		if (
			!(await confirmDialog(
				`Delete ${o.name}? This removes its ${o.serverCount} server${o.serverCount === 1 ? '' : 's'} from the panel, every membership and invite link. Audit history is kept.`,
				{ okLabel: 'Delete organisation', danger: true }
			))
		)
			return;
		await run(() => api('DELETE', `/api/orgs/${encodeURIComponent(o.id)}`), `${o.name} deleted.`);
	}
</script>

<svelte:head><title>Organisations · {data.appName}</title></svelte:head>

<div class="mb-5 flex items-center gap-3">
	<h1 class="text-xl font-semibold tracking-tight">Organisations</h1>
	{#if data.canCreateOrg}
		<button class="ml-auto btn btn-primary" onclick={() => (dialog = { kind: 'create', name: '' })}
			>New organisation</button
		>
	{/if}
</div>

<div class="callout">
	An <b>organisation</b> is a clan or community with its own servers, members and invite links. Its
	<b>owners</b> add servers, mint invite links and decide who gets which role on each server; they
	are admin on every server in it. <b>Members</b> see the servers they were granted.
	{#if siteOwner}As site owner you see and run every organisation: raise a server limit, suspend or
		delete one from here or from its page.{/if}
</div>

<div class="table-wrap">
	<table>
		<thead
			><tr
				><th>Organisation</th>{#if siteOwner}<th>Created</th><th>Status</th>{:else}<th>Your role</th
					>{/if}<th class="num">Members</th><th class="num">Servers</th><th></th></tr
			></thead
		>
		<tbody>
			{#each data.orgViews as o (o.id)}
				<tr class={o.suspended ? 'text-mist-400' : ''}>
					<td>
						{#if o.role === 'owner' && (!o.suspended || siteOwner)}
							<a
								href="/orgs/{encodeURIComponent(o.id)}"
								class="font-medium text-accent hover:underline">{o.name}</a
							>
						{:else if o.lists}
							<a
								href="/orgs/{encodeURIComponent(o.id)}/bans"
								class="font-medium text-accent hover:underline">{o.name}</a
							>
						{:else}
							<span class="font-medium">{o.name}</span>
						{/if}
						<div class="font-mono text-[12px] text-mist-600">{o.slug}</div>
					</td>
					{#if siteOwner}
						<td class="whitespace-nowrap">
							<div>{fmtTime(o.createdAt)}</div>
							<div class="font-mono text-[12px] text-mist-600">
								{o.createdBy ? `@${o.createdBy.username}` : '—'}
							</div>
						</td>
						<td>
							{#if o.suspended}
								<Badge tone="err">suspended</Badge>
								{#if o.suspended.reason}<div
										class="mt-1 max-w-[220px] truncate text-[12px] text-mist-600"
										title={o.suspended.reason}
									>
										{o.suspended.reason}
									</div>{/if}
							{:else}
								<Badge tone="ok">active</Badge>
							{/if}
						</td>
					{:else}
						<td>
							<RoleBadge role={o.role} />
							{#if o.suspended}<Badge tone="err" class="ml-1">suspended</Badge>{/if}
						</td>
					{/if}
					<td class="num">{o.memberCount}</td>
					<td class="num">
						{o.serverCount}
						<span class="text-mist-600">/ {o.serverLimit}</span>
					</td>
					<td class="text-right whitespace-nowrap">
						<span class="inline-flex gap-1.5">
							{#if o.role === 'owner' && (!o.suspended || siteOwner)}
								<a class="btn btn-sm" href="/orgs/{encodeURIComponent(o.id)}">Manage</a>
							{/if}
							{#if o.lists}
								<a class="btn btn-sm" href="/orgs/{encodeURIComponent(o.id)}/bans">Ban list</a>
								<a class="btn btn-sm" href="/orgs/{encodeURIComponent(o.id)}/reserved"
									>Reserved slots</a
								>
							{/if}
							{#if siteOwner}
								{#if o.suspended}
									<button class="btn btn-sm" onclick={() => restore(o)} disabled={busy}
										>Restore</button
									>
								{:else}
									<button
										class="btn btn-sm"
										onclick={() => (dialog = { kind: 'suspend', org: o, reason: '' })}
										disabled={busy}>Suspend</button
									>
								{/if}
								<button class="btn btn-sm btn-danger" onclick={() => remove(o)} disabled={busy}
									>Delete</button
								>
							{/if}
						</span>
					</td>
				</tr>
			{:else}
				<tr
					><td colspan="6" class="py-8 text-center text-mist-600"
						>{siteOwner
							? 'No organisations yet.'
							: data.canCreateOrg
								? 'You are not in an organisation yet. Ask for an invite link, or create your own.'
								: 'You are not in an organisation yet. Ask for an invite link.'}</td
					></tr
				>
			{/each}
		</tbody>
	</table>
</div>

{#if dialog?.kind === 'create'}
	{@const d = dialog}
	<Modal title="New organisation" onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void create();
			}}
		>
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					bind:value={d.name}
					placeholder="Clan or community name"
					minlength="2"
					maxlength="60"
					required
				/></label
			>
			<p class="note">You become its first owner. Add servers and invite links from its page.</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}>Create</button>
			</div>
		</form>
	</Modal>
{:else if dialog?.kind === 'suspend'}
	{@const d = dialog}
	<Modal title="Suspend {d.org.name}" onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				suspend();
			}}
		>
			<p class="text-[13.5px]">
				Members lose access to its servers, its owners cannot add servers or mint links, and its
				invite links stop working until you restore it. Nothing is deleted.
			</p>
			<label class="block"
				><span class="field-label">Reason (shown to its owners)</span><input
					class="input"
					type="text"
					bind:value={d.reason}
					maxlength="300"
				/></label
			>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-danger" disabled={busy}>Suspend</button>
			</div>
		</form>
	</Modal>
{/if}
