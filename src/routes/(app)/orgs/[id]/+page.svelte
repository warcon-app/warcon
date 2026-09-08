<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { InviteView, OrgMemberView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ROLES = ['viewer', 'operator', 'admin'];

	type Dialog =
		| { kind: 'rename'; name: string }
		| {
				kind: 'invite';
				label: string;
				orgRole: 'owner' | 'member';
				serverRole: string;
				expiresDays: string;
				maxUses: string;
		  }
		| { kind: 'created'; invite: InviteView }
		| { kind: 'grants'; member: OrgMemberView; grants: Record<string, string> };
	let dialog = $state<Dialog | null>(null);
	let busy = $state(false);

	let orgPath = $derived(`/api/orgs/${encodeURIComponent(data.org.id)}`);

	async function run(fn: () => Promise<void>, done: string, close = true) {
		busy = true;
		try {
			await fn();
			if (done) toast(done, 'ok');
			if (close) dialog = null;
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast('Invite link copied.', 'ok');
		} catch {
			window.prompt('Copy the invite link:', text);
		}
	}

	const openInvite = () => {
		dialog = {
			kind: 'invite',
			label: '',
			orgRole: 'member',
			serverRole: 'viewer',
			expiresDays: '7',
			maxUses: ''
		};
	};
	function createInvite() {
		const d = dialog;
		if (!d || d.kind !== 'invite') return;
		void run(
			async () => {
				const res = await api<{ invite: InviteView }>('POST', `${orgPath}/invites`, {
					label: d.label,
					orgRole: d.orgRole,
					serverRole: d.serverRole || null,
					expiresDays: d.expiresDays ? Number(d.expiresDays) : null,
					maxUses: d.maxUses ? Number(d.maxUses) : null
				});
				dialog = { kind: 'created', invite: res.invite };
			},
			'',
			false
		);
	}
	async function revoke(inv: InviteView) {
		if (
			!(await confirmDialog(
				'Revoke this invite link? Anyone who already joined keeps their access.',
				{
					okLabel: 'Revoke',
					danger: true
				}
			))
		)
			return;
		await run(() => api('DELETE', `${orgPath}/invites/${inv.id}`), 'Invite link revoked.');
	}

	function setRole(m: OrgMemberView, role: string) {
		void run(
			() => api('PATCH', `${orgPath}/members/${m.userId}`, { role }),
			`@${m.username} is now ${role}.`
		);
	}
	const openGrants = (m: OrgMemberView) => {
		const grants: Record<string, string> = {};
		for (const s of data.orgServers)
			grants[s.id] = m.grants.find((g) => g.serverId === s.id)?.role ?? '';
		dialog = { kind: 'grants', member: m, grants };
	};
	function saveGrants() {
		const d = dialog;
		if (!d || d.kind !== 'grants') return;
		const grants = Object.entries(d.grants)
			.filter(([, role]) => role)
			.map(([serverId, role]) => ({ serverId, role }));
		void run(
			() => api('PUT', `${orgPath}/members/${d.member.userId}/grants`, { grants }),
			'Access updated.'
		);
	}
	async function remove(m: OrgMemberView) {
		if (
			!(await confirmDialog(
				`Remove @${m.username} from ${data.org.name}? Their access to its servers is removed; their account stays.`,
				{ okLabel: 'Remove', danger: true }
			))
		)
			return;
		await run(() => api('DELETE', `${orgPath}/members/${m.userId}`), 'Member removed.');
	}

	function rename() {
		const d = dialog;
		if (!d || d.kind !== 'rename') return;
		void run(() => api('PATCH', orgPath, { name: d.name.trim() }), 'Organisation renamed.');
	}
	async function deleteOrg() {
		const n = data.orgServers.length;
		if (
			!(await confirmDialog(
				`Delete ${data.org.name}? This removes its ${n} server${n === 1 ? '' : 's'} from the panel, every membership and invite link. Audit history is kept.`,
				{ okLabel: 'Delete organisation', danger: true }
			))
		)
			return;
		busy = true;
		try {
			await api('DELETE', orgPath);
			toast('Organisation deleted.', 'ok');
			await invalidateAll();
			await goto('/orgs');
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	const STATUS_BADGE: Record<InviteView['status'], { tone: 'ok' | 'warn' | 'err'; text: string }> =
		{
			live: { tone: 'ok', text: 'live' },
			revoked: { tone: 'err', text: 'revoked' },
			expired: { tone: 'warn', text: 'expired' },
			used: { tone: 'warn', text: 'used up' }
		};
	const usesLabel = (inv: InviteView) =>
		inv.maxUses === null ? `${inv.uses}` : `${inv.uses} / ${inv.maxUses}`;

	// --- site owner controls ---
	let limitInput = $state('');
	let suspendReason = $state('');
	$effect(() => {
		limitInput = data.org.customServerLimit === null ? '' : String(data.org.customServerLimit);
	});
	function saveLimit() {
		void run(
			() =>
				api('PATCH', orgPath, {
					serverLimit: limitInput.trim() === '' ? null : Number(limitInput)
				}),
			'Server limit updated.',
			false
		);
	}
	async function suspend() {
		if (
			!(await confirmDialog(
				`Suspend ${data.org.name}? Members lose access to its servers and its invite links stop working until you restore it.`,
				{ okLabel: 'Suspend', danger: true }
			))
		)
			return;
		await run(
			() => api('PATCH', orgPath, { suspended: true, reason: suspendReason.trim() }),
			'Organisation suspended.',
			false
		);
	}
	function restore() {
		void run(() => api('PATCH', orgPath, { suspended: false }), 'Organisation restored.', false);
	}
</script>

<svelte:head><title>{data.org.name} · {data.appName}</title></svelte:head>

<div class="mb-5 flex flex-wrap items-center gap-3">
	<div>
		<a href="/orgs" class="caps text-mist-400 hover:text-mist-100">Organisations</a>
		<h1 class="text-xl font-semibold tracking-tight">{data.org.name}</h1>
	</div>
	<span class="ml-auto inline-flex gap-1.5">
		<button class="btn btn-sm" onclick={() => (dialog = { kind: 'rename', name: data.org.name })}
			>Rename</button
		>
		<button class="btn btn-sm btn-danger" onclick={deleteOrg} disabled={busy}>Delete</button>
	</span>
</div>

{#if data.org.suspended}
	<div class="callout border-l-danger">
		<b>Suspended</b> since {fmtTime(data.org.suspended.at)}{#if data.org.suspended.reason}: {data
				.org.suspended.reason}{/if}. Members cannot open its servers, and invite links do not work,
		until the site owner restores it.
	</div>
{/if}

<div class="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
	<div class="space-y-4">
		<div class="panel">
			<div class="mb-3 flex items-center gap-3">
				<span class="label-sm mb-0!">Invite links</span>
				<button class="ml-auto btn btn-sm btn-primary" onclick={openInvite}>New invite link</button>
			</div>
			<p class="mb-3 text-[13px] text-mist-400">
				Paste a link into your Discord. Whoever opens it signs in with Discord (or an existing
				username) and joins with the roles below.
				{#if !data.discord}<span class="text-warn"
						>Discord sign-in is not configured, so only people who already have an account can use a
						link.</span
					>{/if}
			</p>
			<div class="table-wrap">
				<table>
					<thead
						><tr
							><th>Label</th><th>Joins as</th><th class="num">Uses</th><th>Expires</th><th
								>Status</th
							><th></th></tr
						></thead
					>
					<tbody>
						{#each data.invites as inv (inv.id)}
							{@const status = inv.status}
							<tr class={status === 'live' ? '' : 'text-mist-600'}>
								<td>
									<div>{inv.label || '—'}</div>
									<div class="font-mono text-[11px] text-mist-600">
										{fmtTime(inv.createdAt)}
									</div>
								</td>
								<td>
									<span class="inline-flex flex-wrap items-center gap-1">
										<RoleBadge role={inv.orgRole} />
										{#if inv.serverRole}<RoleBadge role={inv.serverRole} />{:else}<Badge
												>no servers</Badge
											>{/if}
									</span>
								</td>
								<td class="num">{usesLabel(inv)}</td>
								<td class="whitespace-nowrap">{inv.expiresAt ? fmtTime(inv.expiresAt) : 'never'}</td
								>
								<td>
									<Badge tone={STATUS_BADGE[status].tone}>{STATUS_BADGE[status].text}</Badge>
								</td>
								<td class="text-right whitespace-nowrap">
									<span class="inline-flex gap-1.5">
										{#if status === 'live'}
											<button class="btn btn-sm" onclick={() => copy(inv.url)}>Copy link</button>
											<button class="btn btn-sm btn-danger" onclick={() => revoke(inv)}
												>Revoke</button
											>
										{/if}
									</span>
								</td>
							</tr>
						{:else}
							<tr
								><td colspan="6" class="py-6 text-center text-mist-600">No invite links yet.</td
								></tr
							>
						{/each}
					</tbody>
				</table>
			</div>
		</div>

		<div class="panel">
			<span class="label-sm">Members</span>
			<div class="table-wrap">
				<table>
					<thead
						><tr><th>Member</th><th>Org role</th><th>Server access</th><th>Joined</th><th></th></tr
						></thead
					>
					<tbody>
						{#each data.members as m (m.userId)}
							<tr>
								<td>
									<div>
										{m.name || m.username}
										{#if m.siteOwner}<Badge tone="accent" class="ml-1">site owner</Badge>{/if}
										{#if m.disabled}<Badge tone="err" class="ml-1">disabled</Badge>{/if}
									</div>
									<div class="font-mono text-[12px] text-mist-600">@{m.username}</div>
								</td>
								<td>
									<select
										class="input w-32"
										value={m.role}
										disabled={busy}
										onchange={(e) => setRole(m, (e.currentTarget as HTMLSelectElement).value)}
									>
										<option value="member">member</option>
										<option value="owner">owner</option>
									</select>
								</td>
								<td>
									{#if m.role === 'owner'}
										<span class="text-mist-400">all servers (owner)</span>
									{:else if m.grants.length}
										<div class="flex flex-wrap gap-1.5 max-md:max-w-[240px]">
											{#each m.grants as g (g.serverId)}
												<span
													class="inline-flex items-center gap-1.5 rounded-[2px] border border-black bg-ink-950 py-0.5 pr-1 pl-2 text-[12px]"
													>{g.serverName} <RoleBadge role={g.role} /></span
												>
											{/each}
										</div>
									{:else}
										<span class="text-mist-600">none</span>
									{/if}
								</td>
								<td class="whitespace-nowrap text-mist-400">{fmtTime(m.joinedAt)}</td>
								<td class="text-right whitespace-nowrap">
									<span class="inline-flex gap-1.5">
										{#if m.role !== 'owner'}
											<button class="btn btn-sm" onclick={() => openGrants(m)}>Access</button>
										{/if}
										{#if m.userId !== data.user.id}
											<button class="btn btn-sm btn-danger" onclick={() => remove(m)}>Remove</button
											>
										{/if}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</div>

	<div class="space-y-4 self-start">
		{#if data.user.role === 'owner'}
			<div class="panel border-accent/40">
				<span class="label-sm">Site owner controls</span>
				<div class="kv">
					<span class="text-mist-400">Created</span>
					<span
						>{fmtTime(data.org.createdAt)}{#if data.org.createdBy}&nbsp;by @{data.org.createdBy
								.username}{/if}</span
					>
				</div>
				<div class="kv items-center">
					<span class="text-mist-400">Server limit</span>
					<span class="join">
						<input
							class="input w-24 text-right"
							type="number"
							min="0"
							max="1000"
							bind:value={limitInput}
							placeholder="default"
							aria-label="Server limit"
						/>
						<button type="button" class="btn btn-sm h-auto" onclick={saveLimit} disabled={busy}
							>Save</button
						>
					</span>
				</div>
				<p class="note">
					Blank uses the instance default. Currently {data.org.serverCount} of {data.org
						.serverLimit}.
				</p>
				<div class="mt-3 border-t border-white/8 pt-3">
					{#if data.org.suspended}
						<button type="button" class="btn btn-sm" onclick={restore} disabled={busy}
							>Restore organisation</button
						>
					{:else}
						<div class="join w-full">
							<input
								class="input"
								type="text"
								bind:value={suspendReason}
								placeholder="Reason (shown to its owners)"
								maxlength="300"
							/>
							<button
								type="button"
								class="btn btn-sm h-auto btn-danger"
								onclick={suspend}
								disabled={busy}>Suspend</button
							>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="panel">
			<div class="mb-3 flex items-center gap-3">
				<span class="label-sm mb-0!"
					>Servers <span class="text-mist-600"
						>{data.orgServers.length} / {data.org.serverLimit}</span
					></span
				>
				<a class="ml-auto btn btn-sm" href="/servers">Manage servers</a>
			</div>
			{#each data.orgServers as s (s.id)}
				<div class="kv items-center">
					<a href="/server/{encodeURIComponent(s.id)}" class="text-accent hover:underline"
						>{s.name}</a
					>
					<span class="font-mono text-[12px] text-mist-600">{s.host}:{s.port}</span>
				</div>
			{:else}
				<p class="text-[13px] text-mist-400">
					No servers yet. <a href="/servers" class="text-accent underline">Add one</a>; members with
					a default server role on their invite link only get access to servers that exist when they
					join.
				</p>
			{/each}
		</div>
	</div>
</div>

{#if dialog?.kind === 'rename'}
	{@const d = dialog}
	<Modal title="Rename organisation" onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				rename();
			}}
		>
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					bind:value={d.name}
					minlength="2"
					maxlength="60"
					required
				/></label
			>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}>Save</button>
			</div>
		</form>
	</Modal>
{:else if dialog?.kind === 'invite'}
	{@const d = dialog}
	<Modal title="New invite link" onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				createInvite();
			}}
		>
			<label class="block"
				><span class="field-label">Label (for you)</span><input
					class="input"
					type="text"
					bind:value={d.label}
					placeholder="e.g. #recruitment channel"
					maxlength="60"
				/></label
			>
			<div class="grid grid-cols-2 gap-2">
				<label class="block"
					><span class="field-label">Joins as</span>
					<select class="input" bind:value={d.orgRole}
						><option value="member">member</option><option value="owner">owner</option></select
					>
				</label>
				<label class="block"
					><span class="field-label">Access to current servers</span>
					<select class="input" bind:value={d.serverRole}>
						<option value="">none (grant later)</option>
						{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
					</select>
				</label>
				<label class="block"
					><span class="field-label">Expires</span>
					<select class="input" bind:value={d.expiresDays}>
						<option value="1">in 1 day</option>
						<option value="7">in 7 days</option>
						<option value="30">in 30 days</option>
						<option value="">never</option>
					</select>
				</label>
				<label class="block"
					><span class="field-label">Max uses</span><input
						class="input"
						type="number"
						bind:value={d.maxUses}
						placeholder="unlimited"
						min="1"
					/></label
				>
			</div>
			<p class="note">
				An <b>owner</b> link makes joiners admin on every server and lets them manage the org. Keep those
				short-lived and single-use.
			</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}>Create link</button>
			</div>
		</form>
	</Modal>
{:else if dialog?.kind === 'created'}
	{@const d = dialog}
	<Modal title="Invite link ready" onclose={() => (dialog = null)}>
		<p class="mb-3 text-[13.5px]">Paste this into your Discord:</p>
		<div class="join w-full">
			<input class="input font-mono text-[12.5px]" type="text" readonly value={d.invite.url} />
			<button type="button" class="btn btn-primary" onclick={() => copy(d.invite.url)}>Copy</button>
		</div>
		<p class="note">
			Joins as <b>{d.invite.orgRole}</b>{#if d.invite.serverRole}, <b>{d.invite.serverRole}</b> on every
				current server{/if}. {d.invite.expiresAt
				? `Expires ${fmtTime(d.invite.expiresAt)}.`
				: 'Never expires.'}
			{d.invite.maxUses ? `${d.invite.maxUses} use${d.invite.maxUses === 1 ? '' : 's'}.` : ''}
		</p>
		{#snippet actions()}<button type="button" class="btn" onclick={() => (dialog = null)}
				>Done</button
			>{/snippet}
	</Modal>
{:else if dialog?.kind === 'grants'}
	{@const d = dialog}
	<Modal title="Server access for @{d.member.username}" onclose={() => (dialog = null)}>
		{#each data.orgServers as s (s.id)}
			<div class="kv items-center">
				<span
					>{s.name} <span class="font-mono text-[12px] text-mist-600">{s.host}:{s.port}</span></span
				>
				<select class="input w-40" bind:value={d.grants[s.id]}>
					<option value="">no access</option>
					{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
				</select>
			</div>
		{:else}
			<p class="text-mist-400">This organisation has no servers yet.</p>
		{/each}
		{#snippet actions()}
			<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
			<button type="button" class="btn btn-primary" onclick={saveGrants} disabled={busy}
				>Save access</button
			>
		{/snippet}
	</Modal>
{/if}
