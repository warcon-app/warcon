<script lang="ts">
	// Ban a player: across the whole organisation (the org ban list, pushed to every server) or on
	// one server only. Used from the org ban list page, the players page and the dossier.
	import { untrack } from 'svelte';
	import { api, rconPost, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { describeSync, EXPIRY_OPTIONS, expiryIso, REASON_PRESETS } from '$lib/lists';
	import type { ListSyncSummary } from '$lib/types';
	import Modal from './Modal.svelte';

	let {
		orgId,
		orgName = 'the organisation',
		steamId = '',
		name = '',
		server = null,
		canOrg,
		onclose,
		ondone
	}: {
		orgId: string;
		orgName?: string;
		/** fixed when banning a known player; otherwise the dialog asks for one */
		steamId?: string;
		name?: string;
		/** the server the dialog was opened from, if any: offers the "this server only" scope */
		server?: { id: string; name: string } | null;
		/** may the user write to the org list? */
		canOrg: boolean;
		onclose: () => void;
		ondone: (scope: 'org' | 'server') => unknown;
	} = $props();

	// Initial values only: the dialog is created fresh each time it opens.
	let id = $state(untrack(() => steamId));
	let reason = $state('');
	let expiry = $state('0');
	let custom = $state('');
	let scope = $state<'org' | 'server'>(untrack(() => (canOrg ? 'org' : 'server')));
	let busy = $state(false);

	let who = $derived(name ? `${name} (${steamId})` : steamId || 'a player');
	let orgOnly = $derived(!server);

	async function submit() {
		const target = id.trim();
		if (!/^\d{17}$/.test(target)) {
			toast('Enter a 17-digit SteamID64.', 'err');
			return;
		}
		busy = true;
		try {
			if (scope === 'org') {
				const res = await api<{ sync: ListSyncSummary }>(
					'POST',
					`/api/orgs/${encodeURIComponent(orgId)}/lists/ban/entries`,
					{ steamId: target, reason: reason.trim(), expiresAt: expiryIso(expiry, custom) }
				);
				toast(describeSync(res.sync, `Banned ${target} across ${orgName}.`), 'ok', 8000);
			} else if (server) {
				const res = await rconPost<{ message?: string }>(server.id, 'ban', {
					steamId: target,
					reason: reason.trim()
				});
				toast(res?.message || `Banned ${target} on ${server.name}.`, 'ok');
			}
			await ondone(scope);
			onclose();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<Modal title="Ban {who}" {onclose}>
	<form
		class="space-y-3"
		onsubmit={(e) => {
			e.preventDefault();
			void submit();
		}}
	>
		{#if !steamId}
			<label class="block"
				><span class="field-label">SteamID64</span><input
					class="input font-mono"
					type="text"
					inputmode="numeric"
					placeholder="7656119…"
					maxlength="17"
					bind:value={id}
					required
				/></label
			>
		{/if}

		{#if server && canOrg}
			<fieldset class="space-y-1.5">
				<legend class="field-label">Where</legend>
				<label class="flex items-start gap-2">
					<input type="radio" class="mt-1" bind:group={scope} value="org" />
					<span
						><b>Every server in {orgName}</b>
						<span class="block text-[12.5px] text-mist-400"
							>Goes on the organisation's ban list and is pushed to all its servers, now and in
							future.</span
						></span
					>
				</label>
				<label class="flex items-start gap-2">
					<input type="radio" class="mt-1" bind:group={scope} value="server" />
					<span
						><b>{server.name} only</b>
						<span class="block text-[12.5px] text-mist-400"
							>Written to this server's config; the panel does not manage it.</span
						></span
					>
				</label>
			</fieldset>
		{:else if server}
			<p class="note">Written to {server.name}'s config.</p>
		{/if}

		<label class="block"
			><span class="field-label">Reason</span><input
				class="input"
				type="text"
				placeholder="Optional, shown in the server's ban list"
				maxlength="200"
				bind:value={reason}
			/></label
		>
		<div class="flex flex-wrap gap-1.5">
			{#each REASON_PRESETS as preset (preset)}
				<button
					type="button"
					class="chip cursor-pointer hover:bg-white/12 {reason === preset ? 'text-accent' : ''}"
					onclick={() => (reason = preset)}>{preset}</button
				>
			{/each}
		</div>

		{#if scope === 'org' || orgOnly}
			<div class="flex flex-wrap gap-3">
				<label class="block sm:w-48"
					><span class="field-label">Expires</span><select class="input" bind:value={expiry}>
						{#each EXPIRY_OPTIONS as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select></label
				>
				{#if expiry === 'custom'}
					<label class="block sm:flex-1"
						><span class="field-label">Until (local time)</span><input
							class="input"
							type="datetime-local"
							bind:value={custom}
							required
						/></label
					>
				{/if}
			</div>
		{/if}

		<div class="flex justify-end gap-2 pt-2">
			<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
			<button type="submit" class="btn btn-danger" disabled={busy}>Ban</button>
		</div>
	</form>
</Modal>
