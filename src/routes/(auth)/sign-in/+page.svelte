<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let busy = $state(false);
	let oauthError = $derived(
		page.url.searchParams.get('error') === 'discord'
			? 'Discord sign-in failed. That Discord account is not linked to a panel account here: open an invite link from your organisation, or link Discord from your account page.'
			: ''
	);
	let action = $derived(
		(name: string) =>
			`?/${name}${data.next === '/' ? '' : `&next=${encodeURIComponent(data.next)}`}`
	);
</script>

<svelte:head><title>Sign in · {data.appName}</title></svelte:head>

<form
	method="post"
	action={action('password')}
	class="space-y-4"
	use:enhance={() => {
		busy = true;
		return async ({ update }) => {
			await update();
			busy = false;
		};
	}}
>
	<label class="block">
		<span class="field-label">Username</span>
		<input
			class="input"
			name="username"
			type="text"
			autocomplete="username"
			spellcheck="false"
			required
			value={form?.username ?? ''}
		/>
	</label>
	<label class="block">
		<span class="field-label">Password</span>
		<input class="input" name="password" type="password" autocomplete="current-password" required />
	</label>
	{#if form?.error || oauthError}
		<div
			class="rounded-ctl border border-danger/30 bg-danger/12 px-3 py-2 text-[13px] text-danger"
			role="alert"
		>
			{form?.error || oauthError}
		</div>
	{/if}
	<button class="btn w-full btn-primary" type="submit" disabled={busy}
		>{busy ? 'Signing in…' : 'Sign in'}</button
	>
</form>

{#if data.discord}
	<form method="post" action={action('discord')} class="mt-3" use:enhance>
		<button class="btn w-full" type="submit">Sign in with Discord</button>
	</form>
{/if}

{#if data.orgSignup}
	<p class="note text-center">
		Run a clan or community? <a href="/sign-up" class="text-accent underline"
			>Create your own organisation</a
		>.
	</p>
{/if}
