<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import RegisterForm from '$lib/components/RegisterForm.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let busy = $state(false);
	let oauthError = $derived(
		page.url.searchParams.get('error') === 'discord' ? 'Discord sign-in failed. Try again.' : ''
	);
	let signInHref = $derived(`/sign-in?next=${encodeURIComponent(page.url.pathname)}`);
</script>

<svelte:head><title>Join · {data.appName}</title></svelte:head>

{#if !data.valid || !data.org}
	<div class="caps text-mist-400">Invite link</div>
	<p class="mt-2 text-[15px]">{data.problem}</p>
	<p class="note">Ask whoever shared it for a fresh one.</p>
	{#if data.user}
		<a href="/" class="mt-4 btn w-full">Back to the dashboard</a>
	{:else}
		<a href="/sign-in" class="mt-4 btn w-full">Sign in</a>
	{/if}
{:else}
	<div class="caps text-mist-400">You are invited to join</div>
	<div class="mt-1 text-[22px] font-semibold tracking-tight">{data.org.name}</div>
	<div class="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mist-400">
		<span>as</span>
		<RoleBadge role={data.orgRole ?? 'member'} />
		{#if data.serverRole}
			<span>with</span>
			<RoleBadge role={data.serverRole} />
			<span>access to its servers</span>
		{:else}
			<span>(an owner grants server access afterwards)</span>
		{/if}
	</div>

	{#if form?.error || oauthError}
		<div
			class="mt-4 rounded-ctl border border-danger/30 bg-danger/12 px-3 py-2 text-[13px] text-danger"
			role="alert"
		>
			{form?.error || oauthError}
		</div>
	{/if}

	{#if data.user}
		<div class="mt-5 kv">
			<span class="text-mist-400">Signed in as</span>
			<span
				>{data.user.name} <span class="font-mono text-mist-400">@{data.user.username}</span></span
			>
		</div>
		{#if data.alreadyMember}
			<p class="mt-4 text-[13.5px]">You are already a member of {data.org.name}.</p>
			<a href="/" class="mt-3 btn w-full btn-primary">Open the dashboard</a>
		{:else}
			<form
				method="post"
				action="?/join"
				class="mt-4"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update();
						busy = false;
					};
				}}
			>
				<button class="btn w-full btn-primary" type="submit" disabled={busy}
					>{busy ? 'Joining…' : `Join ${data.org.name}`}</button
				>
			</form>
			<form method="post" action="/sign-out" class="mt-3 text-center">
				<button type="submit" class="text-[12.5px] text-mist-400 underline hover:text-mist-100"
					>Not you? Sign out</button
				>
			</form>
		{/if}
	{:else}
		<RegisterForm
			discord={data.discord}
			discordAction="?/discord"
			registerAction="?/register"
			{signInHref}
			discordLabel="Sign in with Discord to join"
			registerLabel="Create account and join"
			turnstileSiteKey={data.turnstileSiteKey}
			{form}
		/>
	{/if}
{/if}
