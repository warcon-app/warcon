<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import RegisterForm from '$lib/components/RegisterForm.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let busy = $state(false);
	let oauthError = $derived(
		page.url.searchParams.get('error') === 'discord' ? 'Discord sign-in failed. Try again.' : ''
	);
	let canCreate = $derived(data.remaining === null || data.remaining > 0);
	// Only the create action echoes the org name back; the register/discord actions do not.
	let orgName = $derived((form as { orgName?: string } | null)?.orgName ?? '');
</script>

<svelte:head><title>Create an organisation · {data.appName}</title></svelte:head>

<div class="caps text-mist-400">Set up your clan or community</div>
<div class="mt-1 text-[22px] font-semibold tracking-tight">Create an organisation</div>
<p class="mt-2 text-[13px] text-mist-400">
	You become its owner: add your servers, mint invite links for your Discord, and decide who gets
	which role.
</p>

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
		<span>{data.user.name} <span class="font-mono text-mist-400">@{data.user.username}</span></span>
	</div>
	{#if canCreate}
		<form
			method="post"
			action="?/create"
			class="mt-4 space-y-3"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update({ reset: false });
					busy = false;
				};
			}}
		>
			<label class="block"
				><span class="field-label">Organisation name</span><input
					class="input"
					name="orgName"
					type="text"
					placeholder="Clan or community name"
					minlength="2"
					maxlength="60"
					required
					value={orgName}
				/></label
			>
			<button class="btn w-full btn-primary" type="submit" disabled={busy}
				>{busy ? 'Creating…' : 'Create organisation'}</button
			>
		</form>
		<a
			href="/"
			class="mt-3 block text-center text-[12.5px] text-mist-400 underline hover:text-mist-100"
			>Back to the dashboard</a
		>
	{:else}
		<p class="mt-4 text-[13.5px]">
			You have already created the maximum number of organisations. Ask the site owner if you need
			another.
		</p>
		<a href="/orgs" class="mt-3 btn w-full">Your organisations</a>
	{/if}
{:else}
	<RegisterForm
		discord={data.discord}
		discordAction="?/discord"
		registerAction="?/register"
		signInHref="/sign-in?next=%2Fsign-up"
		discordLabel="Continue with Discord"
		registerLabel="Create account"
		turnstileSiteKey={data.turnstileSiteKey}
		{form}
	/>
{/if}
