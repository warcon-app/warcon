<script lang="ts">
	// An announcement: one message broadcast on several of an organisation's servers at once
	// (POST /api/orgs/:id/broadcast). It lists the servers of one organisation on which the person
	// may chat, every one ticked to start with; each answers for itself, and those that did not take
	// it stay ticked, so Send again goes to them alone.
	import { SvelteSet } from 'svelte/reactivity';
	import { api, ApiError, errorMessage } from '$lib/api';
	import { MAX_CHAT } from '$lib/chat';
	import { can } from '$lib/capabilities';
	import { fmtNum } from '$lib/format';
	import { health, occupancy } from '$lib/health.svelte';
	import { toast } from '$lib/toast.svelte';
	import Badge from './Badge.svelte';
	import Modal from './Modal.svelte';
	import Pulse from './Pulse.svelte';
	import SavedMessages from './SavedMessages.svelte';
	import type { AnnounceAnswer, AnnounceResult, ServerInfo } from '$lib/types';

	type Server = Pick<ServerInfo, 'id' | 'name' | 'orgId' | 'orgName' | 'manager' | 'caps'>;

	let {
		servers,
		orgId = null,
		onclose
	}: {
		/** the servers the page shows, in its order; those without Chat are not offered */
		servers: Server[];
		/** the organisation to start on; else the first that has a server to chat on */
		orgId?: string | null;
		onclose: () => void;
	} = $props();

	const chatOn = (s: Server) => can(s.caps, 'chat.send');

	/** the organisations with a server the person may chat on, in the page's order */
	let orgs = $derived.by(() => {
		const seen = new Map<string, string>();
		for (const s of servers) if (chatOn(s) && !seen.has(s.orgId)) seen.set(s.orgId, s.orgName);
		return [...seen].map(([id, name]) => ({ id, name }));
	});
	// svelte-ignore state_referenced_locally
	let org = $state(orgs.find((o) => o.id === orgId)?.id ?? orgs[0]?.id ?? '');
	let orgName = $derived(orgs.find((o) => o.id === org)?.name ?? '');
	let offered = $derived(servers.filter((s) => s.orgId === org && chatOn(s)));
	/** the org's servers the page shows on which the person may not chat */
	let withheld = $derived(servers.filter((s) => s.orgId === org && !chatOn(s)).length);

	// svelte-ignore state_referenced_locally
	const picked = new SvelteSet<string>(offered.map((s) => s.id));
	let text = $state('');
	let busy = $state(false);
	/** how each server took the last send, by id */
	let results = $state<Record<string, AnnounceResult>>({});

	/** Another organisation starts over: all of its servers ticked, no answers. */
	function chooseOrg(id: string) {
		org = id;
		results = {};
		picked.clear();
		for (const s of offered) picked.add(s.id);
	}

	let chosen = $derived(offered.filter((s) => picked.has(s.id)));
	let allPicked = $derived(offered.length > 0 && chosen.length === offered.length);
	/** the box's saved messages are the organisation's, read through a server it may chat on */
	let via = $derived(chosen[0] ?? offered[0]);

	function pickAll() {
		const clear = allPicked;
		for (const s of offered) {
			if (clear) picked.delete(s.id);
			else picked.add(s.id);
		}
	}
	function pick(id: string) {
		if (picked.has(id)) picked.delete(id);
		else picked.add(id);
	}

	const isAnswer = (v: unknown): v is AnnounceAnswer =>
		!!v && typeof v === 'object' && Array.isArray((v as AnnounceAnswer).results);

	async function send() {
		const serverIds = chosen.map((s) => s.id);
		const message = text.trim();
		if (busy || !serverIds.length || !message) return;
		busy = true;
		try {
			shown(
				await api<AnnounceAnswer>('POST', `/api/orgs/${encodeURIComponent(org)}/broadcast`, {
					message,
					serverIds
				})
			);
		} catch (err) {
			// No server took it: the answer still says how each one did.
			if (err instanceof ApiError && isAnswer(err.data)) shown(err.data);
			else toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
	function shown(answer: AnnounceAnswer) {
		results = Object.fromEntries(answer.results.map((r) => [r.serverId, r]));
		const n = answer.sent + answer.failed;
		if (!answer.failed) {
			toast(`Announced on ${n === 1 ? 'one server' : `all ${n} servers`}.`, 'ok');
			onclose();
			return;
		}
		// whoever did not take it stays ticked, for Send again
		picked.clear();
		for (const r of answer.results) if (!r.ok) picked.add(r.serverId);
		toast(
			answer.sent
				? `Announced on ${answer.sent} of ${n} servers; ${answer.failed} did not take it.`
				: 'No server took the announcement.',
			'err'
		);
	}
	let resend = $derived(chosen.length > 0 && chosen.every((s) => results[s.id]?.ok === false));
</script>

<Modal title="Announce" {onclose}>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void send();
		}}
	>
		{#if orgs.length > 1}
			<label class="block"
				><span class="field-label">Organisation</span>
				<select
					class="input"
					value={org}
					disabled={busy}
					onchange={(e) => chooseOrg(e.currentTarget.value)}
				>
					{#each orgs as o (o.id)}<option value={o.id}>{o.name}</option>{/each}
				</select>
			</label>
		{/if}
		{#if via}
			<div>
				<SavedMessages
					server={via}
					label="Message"
					labelFor="announce-text"
					inputId="announce-text"
					value={text}
					onpick={(t) => (text = t)}
				>
					<input
						id="announce-text"
						class="input"
						type="text"
						placeholder="Shown to everyone on each server ticked…"
						maxlength={MAX_CHAT}
						bind:value={text}
					/>
				</SavedMessages>
			</div>
		{/if}
		<div>
			<div class="mb-1.5 flex items-center justify-between gap-3">
				<span class="field-label mb-0!">Servers</span>
				<span class="text-[12px] text-mist-600">{chosen.length} of {offered.length} ticked</span>
			</div>
			<div class="max-h-64 overflow-y-auto rounded-card border border-black bg-ink-950">
				{#if offered.length > 1}
					<label
						class="flex cursor-pointer items-center gap-2.5 border-b border-white/8 px-3 py-2 text-[13px] text-mist-400"
						><input type="checkbox" checked={allPicked} disabled={busy} onchange={pickAll} />
						Every server of {orgName} you may chat on</label
					>
				{/if}
				{#each offered as s (s.id)}
					{@const r = results[s.id]}
					{@const occ = occupancy[s.id]}
					<label class="flex cursor-pointer items-start gap-2.5 px-3 py-2 text-[13.5px]"
						><input
							type="checkbox"
							class="mt-[3px]"
							checked={picked.has(s.id)}
							disabled={busy}
							onchange={() => pick(s.id)}
						/>
						<span class="min-w-0 flex-1">
							<span class="flex items-center gap-2">
								<Pulse ok={health[s.id]} />
								<span class="truncate font-medium">{s.name}</span>
								<span class="ml-auto shrink-0">
									{#if r}
										<Badge tone={r.ok ? 'ok' : 'err'}>{r.ok ? 'sent' : 'not sent'}</Badge>
									{:else if occ}
										<span class="text-[12px] text-mist-400 tabular"
											>{fmtNum(occ.players)} / {fmtNum(occ.max)}</span
										>
									{:else if health[s.id] === false}
										<span class="text-[12px] text-danger">unreachable</span>
									{/if}
								</span>
							</span>
							{#if r && !r.ok}<span class="block text-[12px] text-danger">{r.message}</span>{/if}
						</span></label
					>
				{/each}
			</div>
			{#if withheld}
				<p class="note">
					{withheld === 1 ? 'One server' : `${withheld} servers`} of {orgName} not listed: your role there
					does not include Chat.
				</p>
			{/if}
		</div>
		<p class="note">
			Each server ticked gets it as a broadcast, the same as one sent from its Overview, and keeps
			it in its audit trail.
		</p>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn btn-ghost" data-close onclick={onclose}>Cancel</button>
			<button
				type="submit"
				class="btn btn-primary"
				disabled={busy || !chosen.length || !text.trim()}
				>{busy
					? 'Sending…'
					: resend
						? `Send again · ${chosen.length}`
						: `Send to ${chosen.length === 1 ? 'one server' : `${chosen.length} servers`}`}</button
			>
		</div>
	</form>
</Modal>
