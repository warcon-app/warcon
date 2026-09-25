<script lang="ts">
	// This server's Discord channels (a section of the Settings tab): the ones that carry its live
	// status card or its team kills, and the form that connects another. A channel connected here
	// is a webhook restricted to this server carrying only those two things; the org page lists it
	// with the rest and is where the audit mirror (bans, kicks, sign-ins) is set up. Each row is a
	// line of text with one Edit button; changing, testing, pausing and disconnecting a channel
	// happen in its dialog.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { ServerInfo, WebhookView } from '$lib/types';
	import type { StatusStyle } from '$lib/status-styles';
	import { effectiveFeatures } from '$lib/features';
	import ChannelFields from './ChannelFields.svelte';

	type Carry = 'card' | 'teamkills' | 'both';
	type CardSettings = {
		style: StatusStyle;
		interval: number;
		linkStatus: boolean;
		linkLeaderboard: boolean;
		linkMatches: boolean;
		linkPanel: boolean;
	};

	let {
		data
	}: { data: { server: ServerInfo; owner: boolean; https: boolean; channels: WebhookView[] } } =
		$props();
	let orgPage = $derived(`/orgs/${encodeURIComponent(data.server.orgId)}`);
	let orgPath = $derived(`/api${orgPage}`);
	let features = $derived(effectiveFeatures(data.server, data.server));
	let label = $state('');
	let url = $state('');
	/** what the new channel is for; the card settings only matter when a card is part of it */
	let carry = $state<Carry>('card');
	let card = $state<CardSettings>({
		style: 'banner',
		interval: 60,
		linkStatus: true,
		linkLeaderboard: true,
		linkMatches: true,
		linkPanel: false
	});
	let wantCard = $derived(carry !== 'teamkills');
	let wantTeamKills = $derived(carry !== 'card');
	let busy = $state(false);
	/** the channel whose dialog is open, with the settings as edited so far */
	let editing = $state<{ w: WebhookView; label: string; carry: Carry; card: CardSettings } | null>(
		null
	);

	async function run(fn: () => Promise<unknown>, done: string): Promise<boolean> {
		busy = true;
		try {
			await fn();
			toast(done, 'ok');
			await invalidateAll();
			return true;
		} catch (err) {
			toast(errorMessage(err), 'err');
			return false;
		} finally {
			busy = false;
		}
	}
	const cardBody = (c: CardSettings) => ({
		statusStyle: c.style,
		statusIntervalS: c.interval,
		linkStatus: c.linkStatus,
		linkLeaderboard: c.linkLeaderboard,
		linkMatches: c.linkMatches,
		linkPanel: c.linkPanel
	});
	async function add() {
		await run(
			() =>
				api('POST', `${orgPath}/webhooks`, {
					label: label.trim() || `${data.server.name} ${wantCard ? 'status' : 'team kills'}`,
					url: url.trim(),
					events: wantTeamKills ? ['teamkills'] : [],
					statusEnabled: wantCard,
					...cardBody(card),
					serverIds: [data.server.id]
				}),
			wantCard
				? 'Channel connected. The card is on its way; pin it in Discord once it lands.'
				: 'Channel connected. Team kills will be posted as the kill feed reports them.'
		);
		label = '';
		url = '';
	}
	/** What a channel carries, in words: "Status card (banner) and team kills". */
	const carries = (w: WebhookView): string => {
		const parts: string[] = [];
		if (w.statusEnabled) parts.push(`status card (${w.statusStyle}, every ${w.statusIntervalS} s)`);
		if (w.events.includes('teamkills')) parts.push('team kills');
		const mirrored = w.events.filter((e) => e !== 'teamkills').length;
		if (mirrored) parts.push(`${mirrored} kind${mirrored === 1 ? '' : 's'} of admin events`);
		const text =
			parts.length > 1
				? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
				: (parts[0] ?? 'nothing');
		return text.charAt(0).toUpperCase() + text.slice(1);
	};
	/** The links a card carries right now, given the pages that are on. */
	const linksOf = (w: WebhookView): string => {
		const on = [
			w.linkStatus && features.status ? 'live status' : '',
			w.linkLeaderboard && features.leaderboards ? 'leaderboard' : '',
			w.linkMatches && features.matches ? 'matches' : '',
			w.linkPanel ? 'panel' : ''
		].filter(Boolean);
		return on.length ? `links to ${on.join(', ')}` : 'no links';
	};
	const carryOf = (w: WebhookView): Carry =>
		w.statusEnabled ? (w.events.includes('teamkills') ? 'both' : 'card') : 'teamkills';
	function openEdit(w: WebhookView) {
		editing = {
			w,
			label: w.label,
			carry: carryOf(w),
			card: {
				style: w.statusStyle,
				interval: w.statusIntervalS,
				linkStatus: w.linkStatus,
				linkLeaderboard: w.linkLeaderboard,
				linkMatches: w.linkMatches,
				linkPanel: w.linkPanel
			}
		};
	}
	/** Sends only what changed; a channel edited here carries nothing but the card and team kills. */
	async function save() {
		const e = editing;
		if (!e) return;
		const wantsCard = e.carry !== 'teamkills';
		const teamKills = e.carry !== 'card';
		const body: Record<string, unknown> = {};
		const name = e.label.trim();
		if (name && name !== e.w.label) body.label = name;
		if (wantsCard !== e.w.statusEnabled) body.statusEnabled = wantsCard;
		if (wantsCard) {
			const now = cardBody(e.card);
			const was = cardBody({
				style: e.w.statusStyle,
				interval: e.w.statusIntervalS,
				linkStatus: e.w.linkStatus,
				linkLeaderboard: e.w.linkLeaderboard,
				linkMatches: e.w.linkMatches,
				linkPanel: e.w.linkPanel
			});
			for (const k of Object.keys(now) as (keyof typeof now)[])
				if (now[k] !== was[k]) body[k] = now[k];
		}
		if (teamKills !== e.w.events.includes('teamkills'))
			body.events = teamKills ? ['teamkills'] : [];
		if (!Object.keys(body).length) {
			editing = null;
			return;
		}
		const ok = await run(
			() => api('PATCH', `${orgPath}/webhooks/${e.w.id}`, body),
			body.statusEnabled === true
				? 'Channel updated. The card is on its way; pin it in Discord once it lands.'
				: 'Channel updated.'
		);
		if (ok) editing = null;
	}
	function testCard(w: WebhookView) {
		void run(
			() => api('POST', `${orgPath}/webhooks/${w.id}/card`, { serverId: data.server.id }),
			'Test card sent. It disappears in a minute.'
		);
	}
	/** What to do about a failure, from Discord's answer. */
	const hintFor = (error: string): string =>
		/404|Unknown Webhook|401|403/i.test(error)
			? 'Discord no longer knows this webhook. Disconnect it and connect a new one.'
			: /rate limit/i.test(error)
				? 'Discord is rate limiting the channel; Warcon backs off and retries.'
				: 'Warcon retries every minute.';
	async function toggle(w: WebhookView) {
		const ok = await run(
			() => api('PATCH', `${orgPath}/webhooks/${w.id}`, { enabled: !w.enabled }),
			w.enabled
				? w.statusEnabled
					? 'Channel paused. The card is taken down and nothing is posted until you enable it again.'
					: 'Channel paused. Nothing is posted until you enable it again.'
				: w.statusEnabled
					? 'Channel enabled. The card is on its way; pin it once it lands.'
					: 'Channel enabled.'
		);
		if (ok) editing = null;
	}
	async function remove(w: WebhookView) {
		// One dialog at a time: the confirmation replaces the edit dialog rather than stacking on it.
		editing = null;
		if (!(await confirmDialog(`Disconnect ${w.label}?`, { okLabel: 'Disconnect', danger: true })))
			return;
		await run(() => api('DELETE', `${orgPath}/webhooks/${w.id}`), 'Channel disconnected.');
	}
	/** A channel this page can manage: this server only, carrying nothing but the card and team kills. */
	const ownHere = (w: WebhookView) =>
		w.serverIds?.length === 1 && w.events.every((e) => e === 'teamkills');
</script>

<div class="panel">
	<div class="mb-3 flex items-center gap-3">
		<span class="label-sm mb-0!">Discord channels</span>
	</div>
	<p class="mb-3 text-[13px] text-mist-400">
		A channel is one Discord webhook URL, and each channel carries what you choose for it. Two
		things belong here: a <b>status card</b> that Warcon posts once and edits in place (players
		online, map, a score bar per faction and who is on each side; <b>pin it in Discord</b> so it
		stays at the top), and <b>team kills</b>, one message each as the kill feed reports them. Use a
		separate channel for each if you want them apart. Mirrors of admin actions (bans, kicks, trigger
		actions, sign-ins) are set up on the <a class="link" href={orgPage}>org page</a>.
	</p>
	{#if data.owner && !data.https}
		<div class="callout mb-3 border-warn/30 bg-warn/12">
			<b>Cards will go out without pictures.</b> Discord only fetches map art and icons over https, and
			this panel is not on https. Everything else on the card works.
		</div>
	{/if}
	{#if !data.owner}
		<p class="note">
			Only an owner of {data.server.orgName} can connect Discord channels, because a webhook URL lets
			anyone post there.
		</p>
	{:else}
		{#each data.channels as w (w.id)}
			<div class="kv items-start">
				<div class="min-w-0">
					<div>
						{w.label}
						{#if !w.enabled}<Badge class="ml-1">paused</Badge>{/if}
						{#if w.lastError}<Badge tone="err" class="ml-1">failing</Badge
							>{:else if w.statusSentAt}<Badge tone="ok" class="ml-1">live</Badge>{/if}
					</div>
					<div class="truncate font-mono text-[11px] text-mist-600">{w.urlHint}</div>
					<div class="text-[12px] text-mist-400">
						{carries(w)}{#if w.statusEnabled}
							· {linksOf(w)}{/if}
						{#if !w.serverIds}· every server in the organisation{:else if w.serverIds.length > 1}·
							this and {w.serverIds.length - 1} other server{w.serverIds.length === 2
								? ''
								: 's'}{/if}
						{#if w.lastError}<div class="text-danger">{w.lastError}</div>
							<div>{hintFor(w.lastError)}</div>{:else if w.statusSentAt}· updated {fmtTime(
								w.statusSentAt
							)}{/if}
					</div>
				</div>
				{#if ownHere(w)}
					<button class="btn btn-sm shrink-0" onclick={() => openEdit(w)} disabled={busy}
						>Edit</button
					>
				{:else}
					<a class="btn btn-sm shrink-0 btn-ghost" href={orgPage}>Edit on the org page</a>
				{/if}
			</div>
		{:else}
			<p class="mb-3 text-[13px] text-mist-600">
				No channel carries this server's card or team kills yet.
			</p>
		{/each}

		<form
			class="mt-4 space-y-3 border-t border-white/8 pt-4"
			onsubmit={(e) => {
				e.preventDefault();
				void add();
			}}
		>
			<span class="field-label">Connect a channel</span>
			<div class="grid gap-3 sm:grid-cols-[1fr_2fr]">
				<label class="block"
					><span class="field-label">Label</span><input
						id="discord-label"
						class="input"
						type="text"
						bind:value={label}
						placeholder="e.g. #eu-1-status"
						maxlength="60"
					/></label
				>
				<label class="block"
					><span class="field-label">Webhook URL</span><input
						id="discord-url"
						class="input font-mono text-[12.5px]"
						type="url"
						bind:value={url}
						placeholder="https://discord.com/api/webhooks/…"
						required
						autocomplete="off"
					/></label
				>
			</div>
			<ChannelFields
				name="carry"
				bind:carry
				bind:style={card.style}
				bind:interval={card.interval}
				bind:linkStatus={card.linkStatus}
				bind:linkLeaderboard={card.linkLeaderboard}
				bind:linkMatches={card.linkMatches}
				bind:linkPanel={card.linkPanel}
				{features}
			/>
			<p class="note">
				In Discord, open the channel's settings → Integrations → Webhooks → New Webhook, copy its
				URL and paste it here. The URL is stored encrypted and never shown again. Pictures need the
				panel to be reachable over https. The public pages a card can link to are switched on below,
				under Public pages.
			</p>
			<div class="flex justify-end">
				<button type="submit" class="btn btn-primary" disabled={busy}>Connect channel</button>
			</div>
		</form>
	{/if}
</div>

{#if editing}
	{@const e = editing}
	<Modal title="Edit {e.w.label}" onclose={() => (editing = null)}>
		<form
			class="space-y-3"
			onsubmit={(ev) => {
				ev.preventDefault();
				void save();
			}}
		>
			<label class="block"
				><span class="field-label">Label</span><input
					class="input"
					type="text"
					bind:value={e.label}
					maxlength="60"
				/></label
			>
			<ChannelFields
				name="edit-carry"
				bind:carry={e.carry}
				bind:style={e.card.style}
				bind:interval={e.card.interval}
				bind:linkStatus={e.card.linkStatus}
				bind:linkLeaderboard={e.card.linkLeaderboard}
				bind:linkMatches={e.card.linkMatches}
				bind:linkPanel={e.card.linkPanel}
				{features}
			/>
			<div class="flex flex-wrap items-center gap-2 pt-2">
				{#if e.w.statusEnabled}
					<button
						type="button"
						class="btn"
						onclick={() => testCard(e.w)}
						disabled={busy || !e.w.enabled}>Test card</button
					>
				{/if}
				<button type="button" class="btn" onclick={() => toggle(e.w)} disabled={busy}
					>{e.w.enabled ? 'Pause' : 'Enable'}</button
				>
				<span class="ml-auto inline-flex gap-2">
					<button type="button" class="btn btn-danger" onclick={() => remove(e.w)} disabled={busy}
						>Disconnect</button
					>
					<button type="submit" class="btn btn-primary" disabled={busy}>Save</button>
				</span>
			</div>
		</form>
	</Modal>
{/if}
