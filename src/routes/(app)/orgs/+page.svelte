<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let creating = $state(false);
	let name = $state('');
	let busy = $state(false);

	async function create() {
		busy = true;
		try {
			const res = await api<{ id: string }>('POST', '/api/orgs', { name: name.trim() });
			toast('Organisation created.', 'ok');
			creating = false;
			name = '';
			await invalidateAll();
			await goto(`/orgs/${encodeURIComponent(res.id)}`);
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Organisations · {data.appName}</title></svelte:head>

<div class="mb-5 flex items-center gap-3">
	<h1 class="text-xl font-semibold tracking-tight">Organisations</h1>
	{#if data.user.role === 'owner'}
		<button class="ml-auto btn btn-primary" onclick={() => (creating = true)}
			>New organisation</button
		>
	{/if}
</div>

<div class="callout">
	An <b>organisation</b> is a clan or community with its own servers, members and invite links. Its
	<b>owners</b> add servers, mint invite links and decide who gets which role on each server; they
	are admin on every server in it. <b>Members</b> see the servers they were granted.
	{#if data.user.role === 'owner'}As site owner you see and run every organisation.{/if}
</div>

<div class="table-wrap">
	<table>
		<thead
			><tr
				><th>Organisation</th><th>Your role</th><th class="num">Members</th><th class="num"
					>Servers</th
				><th></th></tr
			></thead
		>
		<tbody>
			{#each data.orgViews as o (o.id)}
				<tr>
					<td>
						{#if o.role === 'owner'}
							<a
								href="/orgs/{encodeURIComponent(o.id)}"
								class="font-medium text-accent hover:underline">{o.name}</a
							>
						{:else}
							<span class="font-medium">{o.name}</span>
						{/if}
						<div class="font-mono text-[12px] text-mist-600">{o.slug}</div>
					</td>
					<td><RoleBadge role={o.role} /></td>
					<td class="num">{o.memberCount}</td>
					<td class="num">{o.serverCount}</td>
					<td class="text-right whitespace-nowrap">
						{#if o.role === 'owner'}
							<a class="btn btn-sm" href="/orgs/{encodeURIComponent(o.id)}">Manage</a>
						{/if}
					</td>
				</tr>
			{:else}
				<tr
					><td colspan="5" class="py-8 text-center text-mist-600"
						>{data.user.role === 'owner'
							? 'No organisations yet.'
							: 'You are not in an organisation yet. Ask for an invite link.'}</td
					></tr
				>
			{/each}
		</tbody>
	</table>
</div>

{#if creating}
	<Modal title="New organisation" onclose={() => (creating = false)}>
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
					bind:value={name}
					placeholder="Clan or community name"
					minlength="2"
					maxlength="60"
					required
				/></label
			>
			<p class="note">You become its first owner. Add servers and invite links from its page.</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" class="btn" data-close onclick={() => (creating = false)}
					>Cancel</button
				>
				<button type="submit" class="btn btn-primary" disabled={busy}>Create</button>
			</div>
		</form>
	</Modal>
{/if}
