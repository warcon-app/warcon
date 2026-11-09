<script lang="ts">
	// Ban a player: across the whole organisation (the org ban list, pushed to every server) or on
	// one server only. Used from the org ban list page, the players page and the dossier.
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { DEFAULT_BAN_MESSAGE, renderBanMessage } from '$lib/ban-message';
	import { lengthTag, type BanReason } from '$lib/ban-reasons';
	import { describeSync, EXPIRY_OPTIONS, expiryIso } from '$lib/lists';
	import { isSteamId, steamProfiles, type SteamProfile } from '$lib/steam-profiles';
	import type { ListSyncServer, ListSyncSummary } from '$lib/types';
	import Modal from './Modal.svelte';
	import SteamName from './SteamName.svelte';

	let {
		orgId,
		orgName = 'the organisation',
		steamId = '',
		name = '',
		server = null,
		canOrg,
		scope: startScope,
		reason: startReason = '',
		banMessage = null,
		reasons,
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
		/** where the dialog starts when both are offered; every server, unless said otherwise */
		scope?: 'org' | 'server';
		/** a reason typed before the dialog opened */
		reason?: string;
		/** the org's ban message, where the page has it: the dialog then shows the text it makes */
		banMessage?: string | null;
		/** the org's quick reasons, the buttons under Reason */
		reasons: BanReason[];
		onclose: () => void;
		ondone: (scope: 'org' | 'server') => unknown;
	} = $props();

	// Initial values only: the dialog is created fresh each time it opens.
	let id = $state(untrack(() => steamId));
	let reason = $state(untrack(() => startReason));
	let expiry = $state('0');
	let custom = $state('');
	let scope = $state<'org' | 'server'>(
		untrack(() => (canOrg && (startScope !== 'server' || !server) ? 'org' : 'server'))
	);
	let busy = $state(false);

	// What the player will be shown, once the org wraps the reason in more than the reason. The
	// uid comes from the entry, which does not exist yet.
	let shown = $derived.by(() => {
		if (!banMessage || banMessage === DEFAULT_BAN_MESSAGE) return '';
		const until = expiryIso(expiry, custom);
		return renderBanMessage(banMessage.replace(/\{uid\}/gi, 'B-······'), {
			entryId: '',
			reason: reason.trim(),
			addedByName: page.data.user?.username ?? '',
			addedAt: new Date(),
			expiresAt: until ? new Date(until) : null
		});
	});

	/** A quick reason fills in its reason and, when it has a length, sets Expires. */
	function pick(r: BanReason) {
		reason = r.reason;
		if (r.days !== null) expiry = String(r.days);
	}

	let who = $derived(name ? `${name} (${steamId})` : steamId || 'a player');
	// A typed id is looked up so the admin sees who they are about to ban.
	let previewId = $derived(steamId ? '' : isSteamId(id.trim()) ? id.trim() : '');
	let preview = $state<SteamProfile | null | undefined>(undefined);
	$effect(() => {
		const want = previewId;
		preview = undefined;
		if (!want) return;
		void steamProfiles([want]).then((r) => {
			if (previewId === want && want in r) preview = r[want];
		});
	});

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
				const res = await api<{ sync: ListSyncServer }>(
					'POST',
					`/api/servers/${encodeURIComponent(server.id)}/lists/ban/entries`,
					{ steamId: target, reason: reason.trim(), expiresAt: expiryIso(expiry, custom) }
				);
				// The game only bans a connected player; the list keeps the ban for when they join.
				toast(
					res.sync.ok && res.sync.failed
						? `${target} is not on ${server.name} right now: they are banned the moment they join.`
						: describeSync({ servers: [res.sync] }, `Banned ${target} on ${server.name}.`),
					'ok',
					8000
				);
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
			{#if previewId && preview}
				<div class="mt-1.5 text-[12.5px]"><SteamName profile={preview} /></div>
			{:else if previewId && preview === null}
				<div class="mt-1.5 text-[12.5px] text-mist-600">No Steam profile for that id.</div>
			{/if}
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
							>Goes on this server's own ban list. If the player is not connected, they are banned
							the moment they join.</span
						></span
					>
				</label>
			</fieldset>
		{:else if server}
			<p class="note">
				Goes on {server.name}'s own ban list. If the player is not connected, they are banned the
				moment they join.
			</p>
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
		{#if reasons.length}
			<div class="flex flex-wrap gap-1.5">
				{#each reasons as r (r.label)}
					<button
						type="button"
						class="chip cursor-pointer hover:bg-white/12 {reason === r.reason ? 'text-accent' : ''}"
						title={r.reason}
						onclick={() => pick(r)}
						>{r.label}{#if r.days !== null}<span class="text-mist-400"
								>&nbsp;{lengthTag(r.days)}</span
							>{/if}</button
					>
				{/each}
			</div>
		{/if}

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

		{#if shown}
			<div>
				<span class="field-label">The player is shown</span>
				<div
					class="rounded-ctl border border-black bg-ink-950 px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed break-words"
				>
					{shown}
				</div>
				<p class="note">From {orgName}'s ban message.</p>
			</div>
		{/if}

		<div class="flex justify-end gap-2 pt-2">
			<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
			<button type="submit" class="btn btn-danger" disabled={busy}>Ban</button>
		</div>
	</form>
</Modal>
