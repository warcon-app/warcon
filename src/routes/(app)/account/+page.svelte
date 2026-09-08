<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let forced = $derived(!!page.url.searchParams.get('force') || data.user.mustChangePassword);
	let busy = $state(false);

	$effect(() => {
		if (form?.changed) toast('Password changed. Other sessions were signed out.', 'ok');
		if (form?.revoked) toast('Session revoked.', 'ok');
		if (form?.unlinked) toast('Discord unlinked.', 'ok');
		if (form?.error) toast(form.error, 'err');
	});
</script>

<svelte:head><title>Account · {data.appName}</title></svelte:head>

<h1 class="mb-5 text-xl font-semibold tracking-tight">Account</h1>

{#if forced}
	<div class="callout">You must set a new password before using the panel.</div>
{/if}

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<div class="panel">
		<span class="label-sm">Change password</span>
		<div class="kv">
			<span class="text-mist-400">Signed in as</span>
			<span
				>{data.user.name} <span class="font-mono text-mist-400">@{data.user.username}</span>
				<RoleBadge role={data.user.role} /></span
			>
		</div>
		<form
			method="post"
			action="?/password"
			class="mt-3 space-y-3"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update({ reset: true });
					busy = false;
				};
			}}
		>
			<label class="block"
				><span class="field-label">Current password</span><input
					class="input"
					type="password"
					name="current"
					autocomplete="current-password"
					required
				/></label
			>
			<label class="block"
				><span class="field-label">New password (10+ characters)</span><input
					class="input"
					type="password"
					name="next"
					autocomplete="new-password"
					minlength="10"
					required
				/></label
			>
			<label class="block"
				><span class="field-label">Repeat new password</span><input
					class="input"
					type="password"
					name="again"
					autocomplete="new-password"
					minlength="10"
					required
				/></label
			>
			<button class="btn btn-primary" type="submit" disabled={busy}>Change password</button>
		</form>

		{#if data.discord}
			<div class="mt-6 border-t border-white/8 pt-4">
				<span class="label-sm">Discord</span>
				{#if data.providers.includes('discord')}
					<div class="flex items-center gap-3">
						<Badge tone="ok">linked</Badge>
						<form method="post" action="?/unlinkDiscord" use:enhance>
							<button class="btn btn-sm" type="submit">Unlink</button>
						</form>
					</div>
				{:else}
					<form method="post" action="?/linkDiscord" use:enhance>
						<button class="btn" type="submit">Link Discord for sign-in</button>
					</form>
				{/if}
			</div>
		{/if}
	</div>

	<div class="panel">
		<span class="label-sm">Your sessions</span>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Started</th><th>Last seen</th><th>IP</th><th>Client</th><th></th></tr></thead
				>
				<tbody>
					{#each data.sessions as s (s.id)}
						<tr>
							<td class="whitespace-nowrap">{fmtTime(s.createdAt)}</td>
							<td class="whitespace-nowrap">{fmtTime(s.updatedAt)}</td>
							<td class="font-mono text-[12px]">{s.ip}</td>
							<td class="max-w-[160px] truncate text-mist-400" title={s.userAgent}
								>{s.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 28)}</td
							>
							<td class="text-right">
								{#if s.current}
									<Badge tone="ok">this session</Badge>
								{:else}
									<form method="post" action="?/revoke" use:enhance>
										<input type="hidden" name="id" value={s.id} />
										<button class="btn btn-sm btn-danger" type="submit">Revoke</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
