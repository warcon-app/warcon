<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Setup · {data.appName}</title></svelte:head>

<p class="mb-4 text-[13px] leading-relaxed text-mist-400">
	First run. Create the owner account that will manage servers and users. Choose a strong password
	(10+ characters).
</p>
<form
	method="post"
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
		<span class="field-label">Display name (optional)</span>
		<input class="input" name="displayName" type="text" value={form?.displayName ?? ''} />
	</label>
	<label class="block">
		<span class="field-label">Password</span>
		<input
			class="input"
			name="password"
			type="password"
			autocomplete="new-password"
			minlength="10"
			required
		/>
	</label>
	{#if data.tokenRequired}
		<label class="block">
			<span class="field-label">Setup token</span>
			<input class="input" name="token" type="password" autocomplete="off" required />
			<p class="note">The SETUP_TOKEN secret set by whoever deployed this panel.</p>
		</label>
	{/if}
	{#if form?.error}
		<div
			class="rounded-ctl border border-danger/30 bg-danger/12 px-3 py-2 text-[13px] text-danger"
			role="alert"
		>
			{form.error}
		</div>
	{/if}
	<button class="btn w-full btn-primary" type="submit" disabled={busy}
		>{busy ? 'Creating…' : 'Create owner account'}</button
	>
</form>
