<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtNum } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { OrgMemberView, ServerInfo, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ROLES = ['viewer', 'operator', 'admin'];

	type TestOk = {
		ok: true;
		status: Status;
		capabilities: {
			routes: string[];
			features: { changeTeam: boolean; configDocument: boolean };
		} | null;
		durationMs: number;
	};
	type Dialog =
		| {
				kind: 'edit';
				server: ServerInfo | null;
				orgId: string;
				name: string;
				host: string;
				port: string;
				scheme: 'http' | 'https';
				password: string;
				notes: string;
				sortOrder: string;
		  }
		| { kind: 'test'; server: ServerInfo; result: TestOk }
		| {
				kind: 'access';
				server: ServerInfo;
				members: OrgMemberView[];
				grants: Record<string, string>;
		  };
	let dialog = $state<Dialog | null>(null);
	let busy = $state(false);
	// One org column / group header only once there is more than one org to tell apart.
	let multiOrg = $derived(data.ownedOrgs.length > 1);

	const openEdit = (s: ServerInfo | null) => {
		dialog = {
			kind: 'edit',
			server: s,
			orgId: s?.orgId ?? data.ownedOrgs[0]?.id ?? '',
			name: s?.name ?? '',
			host: s?.host ?? '',
			port: s ? String(s.port) : '',
			scheme: s?.scheme ?? 'http',
			password: '',
			notes: s?.notes ?? '',
			sortOrder: String(s?.sortOrder ?? 0)
		};
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
		const payload: Record<string, unknown> = {
			name: d.name,
			host: d.host,
			port: Number(d.port),
			scheme: d.scheme,
			notes: d.notes,
			sortOrder: Number(d.sortOrder) || 0
		};
		if (d.password) payload.password = d.password;
		if (d.server) {
			const id = d.server.id;
			void run(() => api('PATCH', `/api/servers/${id}`, payload), 'Server updated.');
		} else {
			payload.orgId = d.orgId;
			void run(() => api('POST', '/api/servers', payload), 'Server added.');
		}
	}

	async function test(s: ServerInfo) {
		const hide = toast(`Testing ${s.name}…`, '', 0);
		try {
			const d = await api<TestOk>('POST', `/api/servers/${s.id}/test`);
			dialog = { kind: 'test', server: s, result: d };
		} catch (err) {
			toast(`${s.name}: ${errorMessage(err)}`, 'err');
		} finally {
			hide();
		}
	}

	async function access(s: ServerInfo) {
		try {
			const [res, grants] = await Promise.all([
				api<{ members: OrgMemberView[] }>(
					'GET',
					`/api/orgs/${encodeURIComponent(s.orgId)}/members`
				),
				api<{ grants: { userId: string; role: string }[] }>('GET', `/api/servers/${s.id}/grants`)
			]);
			// Org owners and the site owner are admin regardless of grants.
			const members = res.members.filter((u) => u.role !== 'owner' && !u.siteOwner);
			const map: Record<string, string> = {};
			for (const u of members)
				map[u.userId] = grants.grants.find((g) => g.userId === u.userId)?.role ?? '';
			dialog = { kind: 'access', server: s, members, grants: map };
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	function saveAccess() {
		const d = dialog;
		if (!d || d.kind !== 'access') return;
		const grants = Object.entries(d.grants)
			.filter(([, role]) => role)
			.map(([userId, role]) => ({ userId, role }));
		void run(() => api('PUT', `/api/servers/${d.server.id}/grants`, { grants }), 'Access updated.');
	}
	async function remove(s: ServerInfo) {
		if (
			!(await confirmDialog(
				`Remove ${s.name} from the panel? The game server itself is untouched. Audit history is kept.`,
				{ okLabel: 'Remove', danger: true }
			))
		)
			return;
		await run(() => api('DELETE', `/api/servers/${s.id}`), 'Server removed.');
	}
</script>

<svelte:head><title>Servers · {data.appName}</title></svelte:head>

<div class="mb-5 flex items-center gap-3">
	<h1 class="text-xl font-semibold tracking-tight">Servers</h1>
	<button
		class="ml-auto btn btn-primary"
		onclick={() => openEdit(null)}
		disabled={!data.ownedOrgs.length}>Add server</button
	>
</div>

<div class="callout">
	Each entry is one WARDOGS dedicated server's RCON listener (the <code class="chip"
		>[/Script/WDRCON.WDRCONSettings]</code
	>
	section of its ServerSettings.ini). RCON passwords are encrypted at rest and never shown again.
	{#if data.demoAllowed}Host <code class="chip">demo</code> with password
		<code class="chip">demo</code> uses the built-in mock server.{/if}
	{#if !data.ownedOrgs.length}Servers belong to an organisation, and you do not own one yet: create
		one under <a href="/orgs" class="font-semibold text-accent underline">Orgs</a> first.{/if}
</div>

<div class="table-wrap">
	<table>
		<thead
			><tr
				><th>Name</th>{#if multiOrg}<th>Organisation</th>{/if}<th>Target</th><th class="num"
					>Order</th
				><th></th></tr
			></thead
		>
		<tbody>
			{#each data.managed as s (s.id)}
				<tr>
					<td>
						<a
							href="/server/{encodeURIComponent(s.id)}"
							class="font-medium text-accent hover:underline">{s.name}</a
						>
						{#if s.demo}<Badge tone="info" class="ml-1">demo</Badge>{/if}
						{#if s.notes}<div class="text-[12px] text-mist-400">{s.notes}</div>{/if}
					</td>
					{#if multiOrg}<td
							><a href="/orgs/{encodeURIComponent(s.orgId)}" class="hover:underline">{s.orgName}</a
							></td
						>{/if}
					<td class="font-mono text-[12.5px]">{s.scheme}://{s.host}:{s.port}</td>
					<td class="num">{s.sortOrder}</td>
					<td class="text-right whitespace-nowrap">
						<span class="inline-flex gap-1.5">
							<button class="btn btn-sm" onclick={() => test(s)}>Test</button>
							<button class="btn btn-sm" onclick={() => openEdit(s)}>Edit</button>
							<button class="btn btn-sm" onclick={() => access(s)}>Access</button>
							<button class="btn btn-sm btn-danger" onclick={() => remove(s)}>Delete</button>
						</span>
					</td>
				</tr>
			{:else}
				<tr
					><td colspan={multiOrg ? 5 : 4} class="py-8 text-center text-mist-600">No servers yet.</td
					></tr
				>
			{/each}
		</tbody>
	</table>
</div>

{#if dialog?.kind === 'edit'}
	{@const d = dialog}
	<Modal title={d.server ? `Edit ${d.server.name}` : 'Add server'} onclose={() => (dialog = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			{#if !d.server && multiOrg}
				<label class="block"
					><span class="field-label">Organisation</span>
					<select class="input" bind:value={d.orgId} required>
						{#each data.ownedOrgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
					</select>
				</label>
			{/if}
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					bind:value={d.name}
					placeholder="Display name"
					required
				/></label
			>
			<div class="grid grid-cols-2 gap-2 sm:grid-cols-[3fr_1fr_1fr]">
				<label class="col-span-2 block sm:col-span-1"
					><span class="field-label">Host</span><input
						class="input"
						type="text"
						bind:value={d.host}
						placeholder="IP or hostname"
						spellcheck="false"
						required
					/></label
				>
				<label class="block"
					><span class="field-label">Port</span><input
						class="input"
						type="number"
						bind:value={d.port}
						placeholder="7776"
						min="1"
						max="65535"
						required
					/></label
				>
				<label class="block"
					><span class="field-label">Scheme</span>
					<select class="input" bind:value={d.scheme}
						><option value="http">http</option><option value="https">https</option></select
					>
				</label>
			</div>
			<label class="block"
				><span class="field-label">RCON password</span><input
					class="input"
					type="password"
					bind:value={d.password}
					placeholder={d.server ? '(unchanged)' : 'RCON password'}
					autocomplete="new-password"
					required={!d.server}
				/></label
			>
			<div class="grid grid-cols-1 gap-2 sm:grid-cols-[4fr_1fr]">
				<label class="block"
					><span class="field-label">Notes</span><textarea
						class="input"
						rows="2"
						bind:value={d.notes}
						placeholder="Notes shown to everyone with access (optional)"></textarea></label
				>
				<label class="block"
					><span class="field-label">Sort order</span><input
						class="input"
						type="number"
						bind:value={d.sortOrder}
					/></label
				>
			</div>
			<p class="note">
				The listener must be reachable from the machine running Warcon: keep BindAddress 127.0.0.1
				when they share a host, otherwise 0.0.0.0 behind a firewall or reverse proxy. https needs a
				certificate Warcon trusts, or GAME_TLS_INSECURE=true for self-signed.
			</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}
					>{d.server ? 'Save' : 'Add'}</button
				>
			</div>
		</form>
	</Modal>
{:else if dialog?.kind === 'test'}
	{@const d = dialog}
	<Modal
		title="{d.server.name} — reachable in {d.result.durationMs} ms"
		onclose={() => (dialog = null)}
	>
		<div class="kv">
			<span class="text-mist-400">Server name</span><span>{d.result.status.serverName}</span>
		</div>
		<div class="kv"><span class="text-mist-400">Map</span><span>{d.result.status.map}</span></div>
		<div class="kv">
			<span class="text-mist-400">Players</span><span
				>{fmtNum(d.result.status.playerCount)} / {fmtNum(d.result.status.maxPlayers)}</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Capabilities</span>
			<span class="text-right">
				{#if d.result.capabilities}{d.result.capabilities.routes.length} routes; change team {d
						.result.capabilities.features.changeTeam
						? 'yes'
						: 'no'}; config document {d.result.capabilities.features.configDocument
						? 'yes'
						: 'no'}{:else}not reported (older plugin){/if}
			</span>
		</div>
		{#snippet actions()}<button type="button" class="btn" onclick={() => (dialog = null)}
				>Close</button
			>{/snippet}
	</Modal>
{:else if dialog?.kind === 'access'}
	{@const d = dialog}
	<Modal title="Access to {d.server.name}" onclose={() => (dialog = null)}>
		{#each d.members as u (u.userId)}
			<div class="kv items-center">
				<span
					>{u.name || u.username}
					<span class="font-mono text-[12px] text-mist-600">@{u.username}</span></span
				>
				<select class="input w-40" bind:value={d.grants[u.userId]}>
					<option value="">no access</option>
					{#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
				</select>
			</div>
		{:else}
			<p class="text-mist-400">
				No members besides owners yet. Share an invite link from <a
					href="/orgs/{encodeURIComponent(d.server.orgId)}"
					class="text-accent underline">{d.server.orgName}</a
				>. Owners always have access.
			</p>
		{/each}
		{#snippet actions()}
			<button type="button" class="btn" data-close onclick={() => (dialog = null)}>Cancel</button>
			<button type="button" class="btn btn-primary" onclick={saveAccess} disabled={busy}
				>Save access</button
			>
		{/snippet}
	</Modal>
{/if}
