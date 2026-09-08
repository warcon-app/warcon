<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { UserView } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ROLES = ['viewer', 'operator', 'admin'];

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
	const openGrants = (u: UserView) => {
		const grants: Record<string, string> = {};
		for (const s of data.servers)
			grants[s.id] = u.grants.find((g) => g.serverId === s.id)?.role ?? '';
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
			.filter(([, role]) => role)
			.map(([serverId, role]) => ({ serverId, role }));
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
	<b>Roles.</b> An <b>owner</b> manages users and servers and is admin everywhere. A <b>member</b>
	only sees servers they are granted, at one of three levels:
	<b>viewer</b> (read-only), <b>operator</b> (kick, kill, whisper, broadcast, map and match control,
	live rotation edits),
	<b>admin</b> (plus bans, reserved slots, settings, sponsor image, saving rotation and the config document).
</div>

<div class="table-wrap">
	<table>
		<thead
			><tr
				><th>User</th><th>Role</th><th>Status</th><th>Server access</th><th>Last login</th><th
				></th></tr
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
						{#if u.role === 'owner'}
							<span class="text-mist-400">all servers (owner)</span>
						{:else if u.grants.length}
							<div class="flex flex-wrap gap-1.5">
								{#each u.grants as g (g.serverId)}
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
					><option value="member">member</option><option value="owner">owner</option></select
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
		{#each data.servers as s (s.id)}
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
			<p class="text-mist-400">No servers exist yet.</p>
		{/each}
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
