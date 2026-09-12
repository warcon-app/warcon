<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	let owner = $derived(data.listsRole === 'owner');
	let base = $derived(`/orgs/${encodeURIComponent(data.org.id)}`);
	let orgPath = $derived(`/api/orgs/${encodeURIComponent(data.org.id)}`);
	let current = $derived(page.url.pathname.slice(base.length) || '');

	const TABS = [
		['', 'Overview', true],
		['/access', 'Access', true],
		['/roles', 'Roles', true],
		['/bans', 'Ban list', false],
		['/reserved', 'Reserved slots', false]
	] as const;
	let tabs = $derived(TABS.filter(([, , ownerOnly]) => owner || !ownerOnly));

	let renaming = $state<string | null>(null);
	let busy = $state(false);

	async function rename() {
		if (renaming === null) return;
		busy = true;
		try {
			await api('PATCH', orgPath, { name: renaming.trim() });
			toast('Organisation renamed.', 'ok');
			renaming = null;
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
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
</script>

<svelte:head><title>{data.org.name} · {data.appName}</title></svelte:head>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<div>
		<a href="/orgs" class="caps text-mist-400 hover:text-mist-100">Organisations</a>
		<h1 class="text-xl font-semibold tracking-tight">{data.org.name}</h1>
	</div>
	{#if owner}
		<span class="ml-auto inline-flex gap-1.5">
			<button class="btn btn-sm" onclick={() => (renaming = data.org.name)}>Rename</button>
			<button class="btn btn-sm btn-danger" onclick={deleteOrg} disabled={busy}>Delete</button>
		</span>
	{/if}
</div>

<nav class="strip mb-5 gap-1 border-b border-white/8 pb-3" aria-label="Organisation sections">
	{#each tabs as [path, label] (path)}
		<a href="{base}{path}" class="tab-link {current === path ? 'tab-link-active' : ''}">{label}</a>
	{/each}
</nav>

{#if data.org.suspended}
	<div class="callout border-l-danger">
		<b>Suspended</b> since {fmtTime(data.org.suspended.at)}{#if data.org.suspended.reason}: {data
				.org.suspended.reason}{/if}. Members cannot open its servers, and invite links do not work,
		until the site owner restores it.
	</div>
{/if}

{#key data.org.id}
	{@render children()}
{/key}

{#if renaming !== null}
	<Modal title="Rename organisation" onclose={() => (renaming = null)}>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void rename();
			}}
		>
			<label class="block"
				><span class="field-label">Name</span><input
					class="input"
					type="text"
					bind:value={renaming}
					minlength="2"
					maxlength="60"
					required
				/></label
			>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (renaming = null)}
					>Cancel</button
				>
				<button type="submit" class="btn btn-primary" disabled={busy}>Save</button>
			</div>
		</form>
	</Modal>
{/if}
