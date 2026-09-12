<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import GrantList from '$lib/components/GrantList.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { UserView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Dialog =
		| {
				kind: 'edit';
				user: UserView | null;
				username: string;
				displayName: string;
				password: string;
				role: 'owner' | 'member';
				disabled: boolean;
				mustChange: boolean;
		  }
		| { kind: 'grants'; user: UserView; grants: Record<string, string> }
		| { kind: 'reset'; user: UserView; password: string; mustChange: boolean };
	let dialog = $state<Dialog | null>(null);
	let busy = $state(false);

	const openEdit = (u: UserView | null) => {
		dialog = {
			kind: 'edit',
			user: u,
			username: u?.username ?? '',
			displayName: u?.name ?? '',
			password: '',
			role: u?.role ?? 'member',
			disabled: !!u?.disabled,
			mustChange: u ? u.mustChangePassword : true
		};
	};
	/** "admin 2 · viewer 3": one number per role name rather than one chip per server */
	const grantSummary = (u: UserView) => {
		const counts = new Map<string, number>();
		for (const g of u.grants) counts.set(g.roleName, (counts.get(g.roleName) ?? 0) + 1);
		return [...counts].map(([name, n]) => `${name} ${n}`).join(' · ');
	};
	const openGrants = (u: UserView) => {
		const grants: Record<string, string> = {};
		for (const s of data.servers)
			grants[s.id] = u.grants.find((g) => g.serverId === s.id)?.roleId ?? '';
		dialog = { kind: 'grants', user: u, grants };
	};
	const openReset = (u: UserView) => {
		dialog = { kind: 'reset', user: u, password: '', mustChange: true };
	};

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

	function save() {
		const d = dialog;
		if (!d || d.kind !== 'edit') return;
		if (d.user) {
			const id = d.user.id;
			void run(
				() =>
					api('PATCH', `/api/users/${id}`, {
						displayName: d.displayName,
						role: d.role,
						disabled: d.disabled,
						mustChangePassword: d.mustChange
					}),
				'User updated.'
			);
		} else {
			void run(
				() =>
					api('POST', '/api/users', {
						username: d.username.trim(),
						displayName: d.displayName,
						password: d.password,
						role: d.role,
						mustChangePassword: d.mustChange
					}),
				'User created.'
			);
		}
	}
	function saveGrants() {
		const d = dialog;
		if (!d || d.kind !== 'grants') return;
		const grants = Object.entries(d.grants)
			.filter(([, roleId]) => roleId)
			.map(([serverId, roleId]) => ({ serverId, roleId }));
		void run(() => api('PUT', `/api/users/${d.user.id}/grants`, { grants }), 'Access updated.');
	}
	function reset() {
		const d = dialog;
		if (!d || d.kind !== 'reset') return;
		void run(
			() =>
				api('PATCH', `/api/users/${d.user.id}`, {
					password: d.password,
					mustChangePassword: d.mustChange
				}),
			'Password reset.'
		);
	}
	async function remove(u: UserView) {
		if (
			!(await confirmDialog(
				`Delete @${u.username}? Their audit history is kept, their access is removed.`,
				{ okLabel: 'Delete', danger: true }
			))
		)
			return;
		await run(() => api('DELETE', `/api/users/${u.id}`), 'User deleted.');
	}
</script>

<svelte:head><title>Users · {data.appName}</title></svelte:head>

<div class="mb-5 flex items-center gap-3">
	<h1 class="text-xl font-semibold tracking-tight">Users &amp; access</h1>
	<button class="ml-auto btn btn-primary" onclick={() => openEdit(null)}>Add user</button>
</div>

<div class="callout">
	<b>Every account on this panel.</b> A site <b>owner</b> runs the whole panel and can do everything
	on every server. A <b>member</b> belongs to one or more
	<a href="/orgs" class="text-accent underline">organisations</a>, usually by opening an invite
	link, and sees the servers they are granted there with one of that organisation's roles. Every org
	starts with <b>viewer</b> (read-only), <b>operator</b> (kick, kill, whisper, broadcast, map and
	match control, live rotation edits, notes) and <b>admin</b> (everything on the server); its owners can
	change what those mean and add roles of their own. Granting a server here also makes them a member of
	its organisation.
</div>

<div class="table-wrap">
	<table>
		<thead
			><tr
				><th>User</th><th>Role</th><th>Status</th><th>Organisations</th><th>Server access</th><th
					>Last login</th
				><th></th></tr
			></thead
		>
		<tbody>
			{#each data.users as u (u.id)}
				<tr>
					<td>
						<div>{u.name || u.username}</div>
						<div class="font-mono text-[12px] text-mist-600">@{u.username}</div>
					</td>
					<td><RoleBadge role={u.role} /></td>
					<td>
						{#if u.disabled}<Badge tone="err">disabled</Badge>{:else if u.mustChangePassword}<Badge
								tone="info">must change pw</Badge
							>{:else}<Badge tone="ok">active</Badge>{/if}
					</td>
					<td>
						{#if u.orgs.length}
							<div class="flex flex-wrap gap-1.5">
								{#each u.orgs as o (o.orgId)}
									<span
										class="inline-flex items-center gap-1.5 rounded-[2px] border border-black bg-ink-950 py-0.5 pr-1 pl-2 text-[12px]"
										>{o.orgName} <RoleBadge role={o.role} /></span
									>
								{/each}
							</div>
						{:else}
							<span class="text-mist-600">none</span>
						{/if}
					</td>
					<td>
						{#if u.role === 'owner'}
							<span class="text-mist-400">all servers (site owner)</span>
						{:else if u.grants.length}
							<button
								type="button"
								class="block text-left whitespace-nowrap hover:underline"
								title={u.grants.map((g) => `${g.serverName}: ${g.roleName}`).join('\n')}
								onclick={() => openGrants(u)}
							>
								<div>
									{u.grants.length} of {data.servers.length} server{data.servers.length === 1
										? ''
										: 's'}
								</div>
								<div class="text-[12px] text-mist-400">{grantSummary(u)}</div>
							</button>
						{:else}
							<span class="text-mist-600">none</span>
						{/if}
					</td>
					<td class="whitespace-nowrap text-mist-400">{fmtTime(u.lastLoginAt)}</td>
					<td class="text-right whitespace-nowrap">
						<span class="inline-flex gap-1.5">
							<button class="btn btn-sm" onclick={() => openEdit(u)}>Edit</button>
							{#if u.role !== 'owner'}<button class="btn btn-sm" onclick={() => openGrants(u)}
									>Access</button
								>{/if}
							<button class="btn btn-sm" onclick={() => openReset(u)}>Reset PW</button>
							{#if u.id !== data.user.id}<button
									class="btn btn-sm btn-danger"
									onclick={() => remove(u)}>Delete</button
								>{/if}
						</span>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

{#if dialog?.kind === 'edit'}
	{@const d = dialog}
	<Modal title={d.user ? `Edit @${d.user.username}` : 'Add user'} onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<label class="block"
				><span class="field-label">Username</span><input
					class="input"
					type="text"
					bind:value={d.username}
					disabled={!!d.user}
					autocomplete="off"
					spellcheck="false"
					required
				/></label
			>
			<label class="block"
				><span class="field-label">Display name</span><input
					class="input"
					type="text"
					bind:value={d.displayName}
				/></label
			>
			{#if !d.user}
				<label class="block"
					><span class="field-label">Initial password (10+ characters)</span><input
						class="input"
						type="password"
						bind:value={d.password}
						autocomplete="new-password"
						minlength="10"
						required
					/></label
				>
			{/if}
			<label class="block"
				><span class="field-label">Global role</span>
				<select class="input" bind:value={d.role}
					><option value="member">member</option><option value="owner">site owner</option></select
				>
			</label>
			<div class="flex flex-wrap gap-5 pt-1 text-[13px]">
				{#if d.user}<label class="inline-flex items-center gap-2"
						><input type="checkbox" bind:checked={d.disabled} /> Disabled (signs them out)</label
					>{/if}
				<label class="inline-flex items-center gap-2"
					><input type="checkbox" bind:checked={d.mustChange} /> Must change password at next sign-in</label
				>
			</div>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}
					>{d.user ? 'Save' : 'Create'}</button
				>
			</div>
		</form>
	</Modal>
{:else if dialog?.kind === 'grants'}
	{@const d = dialog}
	<Modal title="Server access for @{d.user.username}" onclose={() => (dialog = null)}>
		<GrantList
			rows={data.servers.map((s) => ({
				id: s.id,
				label: s.name,
				sub: data.orgs.length > 1 ? `${s.orgName} · ${s.host}:${s.port}` : `${s.host}:${s.port}`,
				roles: data.rolesByOrgId[s.orgId] ?? []
			}))}
			bind:grants={d.grants}
			empty="No servers exist yet."
		/>
		{#snippet actions()}
			<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
			<button type="button" class="btn btn-primary" onclick={saveGrants} disabled={busy}
				>Save access</button
			>
		{/snippet}
	</Modal>
{:else if dialog?.kind === 'reset'}
	{@const d = dialog}
	<Modal title="Reset password for @{d.user.username}" onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				reset();
			}}
		>
			<label class="block"
				><span class="field-label">New password (10+ characters)</span><input
					class="input"
					type="password"
					bind:value={d.password}
					autocomplete="new-password"
					minlength="10"
					required
				/></label
			>
			<label class="inline-flex items-center gap-2 text-[13px]"
				><input type="checkbox" bind:checked={d.mustChange} /> Require a new password at next sign-in</label
			>
			<p class="note">All of their sessions are signed out.</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}>Reset</button>
			</div>
		</form>
	</Modal>
{/if}
