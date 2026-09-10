<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { InviteView, OrgMemberView, WebhookView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ROLES = ['viewer', 'operator', 'admin'];

	type Dialog =
		| {
				kind: 'invite';
				label: string;
				orgRole: 'owner' | 'member';
				serverRole: string;
				expiresDays: string;
				maxUses: string;
		  }
		| { kind: 'created'; invite: InviteView }
		| {
				kind: 'webhook';
				id: string | null;
				label: string;
				url: string;
				events: Record<string, boolean>;
				allServers: boolean;
				servers: Record<string, boolean>;
		  };
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
	let accessHref = $derived(`/orgs/${encodeURIComponent(data.org.id)}/access`);
	/** "admin 2 · viewer 3": one number per role rather than one chip per server */
	const grantSummary = (m: OrgMemberView) =>
		ROLES.filter((r) => m.grants.some((g) => g.role === r))
			.map((r) => `${r} ${m.grants.filter((g) => g.role === r).length}`)
			.join(' · ');
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

	const STATUS_BADGE: Record<InviteView['status'], { tone: 'ok' | 'warn' | 'err'; text: string }> =
		{
			live: { tone: 'ok', text: 'live' },
			revoked: { tone: 'err', text: 'revoked' },
			expired: { tone: 'warn', text: 'expired' },
			used: { tone: 'warn', text: 'used up' }
		};
	const usesLabel = (inv: InviteView) =>
		inv.maxUses === null ? `${inv.uses}` : `${inv.uses} / ${inv.maxUses}`;

	// --- Discord webhooks ---
	const openWebhook = (w: WebhookView | null) => {
		const events: Record<string, boolean> = {};
		for (const e of data.webhookEvents)
			events[e.key] = w
				? w.events.includes(e.key)
				: e.key === 'bans' || e.key === 'commands' || e.key === 'triggers';
		const servers: Record<string, boolean> = {};
		for (const s of data.orgServers) servers[s.id] = !!w?.serverIds?.includes(s.id);
		dialog = {
			kind: 'webhook',
			id: w?.id ?? null,
			label: w?.label ?? '',
			url: '',
			events,
			allServers: !w?.serverIds,
			servers
		};
	};
	function saveWebhook() {
		const d = dialog;
		if (!d || d.kind !== 'webhook') return;
		const body: Record<string, unknown> = {
			label: d.label.trim(),
			events: Object.entries(d.events)
				.filter(([, on]) => on)
				.map(([k]) => k),
			serverIds: d.allServers
				? null
				: Object.entries(d.servers)
						.filter(([, on]) => on)
						.map(([k]) => k)
		};
		if (d.url.trim()) body.url = d.url.trim();
		void run(
			() =>
				d.id
					? api('PATCH', `${orgPath}/webhooks/${d.id}`, body)
					: api('POST', `${orgPath}/webhooks`, body),
			d.id ? 'Webhook updated.' : 'Webhook added.'
		);
	}
	function toggleWebhook(w: WebhookView) {
		void run(
			() => api('PATCH', `${orgPath}/webhooks/${w.id}`, { enabled: !w.enabled }),
			w.enabled ? 'Webhook paused.' : 'Webhook enabled.',
			false
		);
	}
	function testWebhook(w: WebhookView) {
		void run(() => api('POST', `${orgPath}/webhooks/${w.id}/test`), 'Test message sent.', false);
	}
	async function deleteWebhook(w: WebhookView) {
		if (
			!(await confirmDialog(`Remove the ${w.label} webhook?`, { okLabel: 'Remove', danger: true }))
		)
			return;
		await run(() => api('DELETE', `${orgPath}/webhooks/${w.id}`), 'Webhook removed.', false);
	}
	const eventLabel = (key: string) =>
		data.webhookEvents.find((e) => e.key === key)?.label.split(' (')[0] ?? key;

	// --- site owner controls ---
	// A number input binds a number, or null when blank (blank = the instance default).
	let limitInput = $state<number | null>(null);
	let suspendReason = $state('');
	$effect(() => {
		limitInput = data.org.customServerLimit;
	});
	function saveLimit() {
		void run(
			() => api('PATCH', orgPath, { serverLimit: limitInput }),
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
										<a
											href={accessHref}
											class="block whitespace-nowrap hover:underline"
											title={m.grants.map((g) => `${g.serverName}: ${g.role}`).join('\n')}
										>
											<div>
												{m.grants.length} of {data.orgServers.length} server{data.orgServers
													.length === 1
													? ''
													: 's'}
											</div>
											<div class="text-[12px] text-mist-400">{grantSummary(m)}</div>
										</a>
									{:else}
										<span class="text-mist-600">none</span>
									{/if}
								</td>
								<td class="whitespace-nowrap text-mist-400">{fmtTime(m.joinedAt)}</td>
								<td class="text-right whitespace-nowrap">
									<span class="inline-flex gap-1.5">
										{#if m.role !== 'owner'}
											<a class="btn btn-sm" href={accessHref}>Access</a>
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
				<span class="label-sm mb-0!">Discord webhooks</span>
				<button class="ml-auto btn btn-sm btn-primary" onclick={() => openWebhook(null)}
					>New webhook</button
				>
			</div>
			<p class="mb-3 text-[13px] text-mist-400">
				Mirror the audit trail into a channel: bans, kicks, trigger actions, sign-ins. In Discord,
				open the channel's settings → Integrations → Webhooks, copy the URL and paste it here.
			</p>
			{#each data.webhooks as w (w.id)}
				<div class="kv items-start">
					<div class="min-w-0">
						<div>
							{w.label}
							{#if !w.enabled}<Badge class="ml-1">paused</Badge>{/if}
							{#if w.lastError}<Badge tone="err" class="ml-1">failing</Badge
								>{:else if w.lastSentAt}<Badge tone="ok" class="ml-1">ok</Badge>{/if}
						</div>
						<div class="truncate font-mono text-[11px] text-mist-600">{w.urlHint}</div>
						<div class="text-[12px] text-mist-400">
							{w.events.map(eventLabel).join(' · ')}
							{#if w.serverIds}· {w.serverIds.length} server{w.serverIds.length === 1
									? ''
									: 's'}{/if}
							{#if w.lastError}<div class="text-danger">{w.lastError}</div>{:else if w.lastSentAt}·
								last sent {fmtTime(w.lastSentAt)}{/if}
						</div>
					</div>
					<span class="inline-flex shrink-0 flex-wrap justify-end gap-1.5">
						<button class="btn btn-sm" onclick={() => testWebhook(w)} disabled={busy}>Test</button>
						<button class="btn btn-sm" onclick={() => openWebhook(w)}>Edit</button>
						<button class="btn btn-sm" onclick={() => toggleWebhook(w)} disabled={busy}
							>{w.enabled ? 'Pause' : 'Enable'}</button
						>
						<button class="btn btn-sm btn-danger" onclick={() => deleteWebhook(w)} disabled={busy}
							>Remove</button
						>
					</span>
				</div>
			{:else}
				<p class="text-[13px] text-mist-600">No webhooks yet.</p>
			{/each}
		</div>

		<div class="panel">
			<span class="label-sm">Ban list and reserved slots</span>
			<div class="space-y-1.5">
				{#each data.lists.lists as l (l.id)}
					<div class="kv items-center">
						<a
							href="/orgs/{encodeURIComponent(data.org.id)}/{l.kind === 'ban'
								? 'bans'
								: 'reserved'}"
							class="text-accent hover:underline"
							>{l.kind === 'ban' ? 'Ban list' : 'Reserved slots'}</a
						>
						<span class="text-mist-400"
							>{l.entryCount} entr{l.entryCount === 1
								? 'y'
								: 'ies'}{#if l.kind === 'reserve' && data.lists.membersReserved}
								· members get a slot{/if}</span
						>
					</div>
				{/each}
			</div>
			<p class="note">
				Pushed to every server in {data.org.name}. Server admins can add and remove entries too.
			</p>
		</div>

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

{#if dialog?.kind === 'invite'}
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
{:else if dialog?.kind === 'webhook'}
	{@const d = dialog}
	<Modal title={d.id ? 'Edit webhook' : 'New Discord webhook'} onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				saveWebhook();
			}}
		>
			<label class="block"
				><span class="field-label">Label</span><input
					class="input"
					type="text"
					bind:value={d.label}
					placeholder="e.g. #admin-log"
					maxlength="60"
				/></label
			>
			<label class="block"
				><span class="field-label">Webhook URL{d.id ? ' (leave blank to keep)' : ''}</span><input
					class="input font-mono text-[12.5px]"
					type="url"
					bind:value={d.url}
					placeholder="https://discord.com/api/webhooks/…"
					required={!d.id}
					autocomplete="off"
				/></label
			>
			<div>
				<span class="field-label">Mirror</span>
				<div class="space-y-1">
					{#each data.webhookEvents as e (e.key)}
						<label class="flex items-center gap-2 text-[13px]"
							><input type="checkbox" bind:checked={d.events[e.key]} /> {e.label}</label
						>
					{/each}
				</div>
			</div>
			{#if data.orgServers.length > 1}
				<div>
					<span class="field-label">Servers</span>
					<label class="flex items-center gap-2 text-[13px]"
						><input type="checkbox" bind:checked={d.allServers} /> Every server in the organisation</label
					>
					{#if !d.allServers}
						<div class="mt-1 space-y-1 pl-5">
							{#each data.orgServers as s (s.id)}
								<label class="flex items-center gap-2 text-[13px]"
									><input type="checkbox" bind:checked={d.servers[s.id]} /> {s.name}</label
								>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			<p class="note">
				The URL lets anyone post to that channel, so it is stored encrypted and never shown again.
				IP addresses are never sent to Discord.
			</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}
					>{d.id ? 'Save' : 'Add webhook'}</button
				>
			</div>
		</form>
	</Modal>
{/if}
