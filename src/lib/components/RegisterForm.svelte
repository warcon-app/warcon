<script lang="ts">
	// "Sign in with Discord" plus a username-and-password alternative, for pages where a visitor
	// without an account may create one (invite links, organisation sign-up).
	import { enhance } from '$app/forms';
	import { resetTurnstile, turnstile } from '$lib/turnstile';

	let {
		discord,
		discordAction,
		registerAction,
		signInHref,
		discordLabel,
		registerLabel,
		turnstileSiteKey = null,
		form
	}: {
		discord: boolean;
		discordAction: string;
		registerAction: string;
		signInHref: string;
		discordLabel: string;
		registerLabel: string;
		/** Cloudflare Turnstile site key; null renders no challenge */
		turnstileSiteKey?: string | null;
		form: { error?: string; username?: string; displayName?: string } | null | undefined;
	} = $props();

	let wantPassword = $state(false);
	// Open the password form straight away when Discord is off, or when a previous attempt failed.
	let showPassword = $derived(wantPassword || !discord || !!form?.username);
	let busy = $state(false);
</script>

{#if discord}
	<form method="post" action={discordAction} class="mt-5" use:enhance>
		<button class="btn w-full btn-primary" type="submit">{discordLabel}</button>
	</form>
	<p class="mt-2 text-center text-[12.5px] text-mist-400">
		No account yet? Discord creates one for you, no password needed.
	</p>
	{#if !showPassword}
		<button type="button" class="mt-3 btn w-full" onclick={() => (wantPassword = true)}
			>Use a username and password instead</button
		>
	{/if}
{/if}

{#if showPassword}
	<form
		method="post"
		action={registerAction}
		class="mt-5 space-y-3 border-t border-white/8 pt-4"
		use:enhance={() => {
			busy = true;
			return async ({ update, result }) => {
				await update({ reset: false });
				if (result.type !== 'redirect') resetTurnstile();
				busy = false;
			};
		}}
	>
		<span class="mb-3 block caps text-mist-400">Create a username and password</span>
		<label class="block"
			><span class="field-label">Username</span><input
				class="input"
				name="username"
				type="text"
				autocomplete="username"
				spellcheck="false"
				minlength="2"
				maxlength="32"
				required
				value={form?.username ?? ''}
			/></label
		>
		<label class="block"
			><span class="field-label">Display name (optional)</span><input
				class="input"
				name="displayName"
				type="text"
				autocomplete="name"
				maxlength="80"
				value={form?.displayName ?? ''}
			/></label
		>
		<label class="block"
			><span class="field-label">Password (10+ characters)</span><input
				class="input"
				name="password"
				type="password"
				autocomplete="new-password"
				minlength="10"
				required
			/></label
		>
		{#if turnstileSiteKey}
			<div use:turnstile={turnstileSiteKey}></div>
		{/if}
		<button class="btn w-full {discord ? '' : 'btn-primary'}" type="submit" disabled={busy}
			>{busy ? 'Creating…' : registerLabel}</button
		>
	</form>
{/if}

<p class="note text-center">
	Already have an account? <a href={signInHref} class="text-accent underline">Sign in</a>.
</p>
