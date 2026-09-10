<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { can, fmtTime, mapLabel } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import MapPicker from '$lib/components/MapPicker.svelte';
	import { watchLive } from '$lib/live';
	import type {
		DryRunResult,
		MapSelection,
		OutboxView,
		TriggerKind,
		TriggerView
	} from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let admin = $derived(can(data.server.role, 'admin'));
	let path = $derived(`/api/servers/${encodeURIComponent(id)}/triggers`);

	/** The last actions the rules took and what became of them; refreshed as deliveries happen. */
	let deliveries = $state<OutboxView[]>([]);
	let deliveriesTimer: ReturnType<typeof setTimeout> | undefined;
	async function refreshDeliveries() {
		try {
			deliveries = (
				await api<{ items: OutboxView[] }>('GET', `/api/servers/${encodeURIComponent(id)}/outbox`)
			).items;
		} catch {
			/* shown as empty */
		}
	}
	$effect(() => {
		void id;
		void refreshDeliveries();
		return watchLive(
			[id],
			() => {},
			() => {
				clearTimeout(deliveriesTimer);
				deliveriesTimer = setTimeout(() => void refreshDeliveries(), 300);
			}
		);
	});
	const stateTone = (s: OutboxView['state']) =>
		s === 'delivered'
			? 'ok'
			: s === 'pending' || s === 'sending'
				? 'info'
				: s === 'skipped'
					? 'warn'
					: 'err';

	const KINDS: { kind: TriggerKind; label: string; blurb: string }[] = [
		{
			kind: 'welcome',
			label: 'Welcome whisper',
			blurb: 'Send a private message to players as they join.'
		},
		{
			kind: 'broadcast',
			label: 'Scheduled broadcast',
			blurb: 'Rotate through messages every few minutes while people are on.'
		},
		{
			kind: 'empty_reset',
			label: 'Empty-server map reset',
			blurb: 'Send an empty server back to a chosen map after a while.'
		},
		{
			kind: 'risk_kick',
			label: 'Kick on connect risk',
			blurb: 'Kick joiners with VAC bans, brand-new accounts, or bans elsewhere in the org.'
		}
	];
	const label = (kind: TriggerKind) => KINDS.find((k) => k.kind === kind)?.label ?? kind;

	interface Form {
		id: string | null;
		kind: TriggerKind;
		name: string;
		enabled: boolean;
		message: string;
		onlyFirstVisit: boolean;
		messages: string;
		everyMinutes: number;
		minPlayers: number;
		afterMinutes: number;
		cooldownMinutes: number;
		vacBans: boolean;
		gameBans: boolean;
		minAccountDays: number;
		privateProfiles: boolean;
		bannedElsewhere: boolean;
		watchlist: boolean;
		spareReserved: boolean;
		reason: string;
	}
	let form = $state<Form | null>(null);
	let picker = $state<MapPicker>();
	let pendingSel = $state<Partial<MapSelection> | null>(null);
	let busy = $state(false);
	let dry = $state<DryRunResult | null>(null);
	let dryBusy = $state(false);
	let dryFor = $state<string | null>(null);

	$effect(() => {
		if (picker && pendingSel) {
			const sel = pendingSel;
			pendingSel = null;
			void picker.setFrom(sel);
		}
	});

	function open(kind: TriggerKind, t?: TriggerView) {
		const c = (t?.config ?? {}) as Record<string, unknown>;
		const s = (k: string, d: string) => (typeof c[k] === 'string' ? (c[k] as string) : d);
		const n = (k: string, d: number) => (typeof c[k] === 'number' ? (c[k] as number) : d);
		const b = (k: string, d: boolean) => (typeof c[k] === 'boolean' ? (c[k] as boolean) : d);
		form = {
			id: t?.id ?? null,
			kind,
			name: t?.name ?? label(kind),
			enabled: t?.enabled ?? true,
			message: s('message', 'Welcome to {server}, {name}! Read the rules with /rules.'),
			onlyFirstVisit: b('onlyFirstVisit', false),
			messages: Array.isArray(c.messages)
				? (c.messages as string[]).join('\n')
				: 'Join our Discord for events and support.\nNo team-killing. Admins are watching.',
			everyMinutes: n('everyMinutes', 15),
			minPlayers: n('minPlayers', 1),
			afterMinutes: n('afterMinutes', 20),
			cooldownMinutes: n('cooldownMinutes', 30),
			vacBans: b('vacBans', true),
			gameBans: b('gameBans', false),
			minAccountDays: n('minAccountDays', 0),
			privateProfiles: b('privateProfiles', false),
			bannedElsewhere: b('bannedElsewhere', true),
			watchlist: b('watchlist', false),
			spareReserved: b('spareReserved', true),
			reason: s('reason', 'Your account does not meet this server’s requirements.')
		};
		dry = null;
		pendingSel =
			kind === 'empty_reset' && t
				? {
						map: s('map', ''),
						experiences: Array.isArray(c.experiences) ? (c.experiences as string[]) : [],
						lighting: s('lighting', ''),
						zoneAlternator: s('zoneAlternator', '')
					}
				: null;
	}

	function config(f: Form): Record<string, unknown> {
		switch (f.kind) {
			case 'welcome':
				return { message: f.message, onlyFirstVisit: f.onlyFirstVisit };
			case 'broadcast':
				return {
					messages: f.messages.split('\n'),
					everyMinutes: Number(f.everyMinutes),
					minPlayers: Number(f.minPlayers)
				};
			case 'empty_reset':
				return {
					...(picker?.selection() ?? {}),
					afterMinutes: Number(f.afterMinutes),
					cooldownMinutes: Number(f.cooldownMinutes)
				};
			case 'risk_kick':
				return {
					vacBans: f.vacBans,
					gameBans: f.gameBans,
					minAccountDays: Number(f.minAccountDays),
					privateProfiles: f.privateProfiles,
					bannedElsewhere: f.bannedElsewhere,
					watchlist: f.watchlist,
					spareReserved: f.spareReserved,
					reason: f.reason
				};
		}
	}

	async function run(fn: () => Promise<unknown>, done: string) {
		busy = true;
		try {
			await fn();
			if (done) toast(done, 'ok');
			await invalidateAll();
			return true;
		} catch (err) {
			toast(errorMessage(err), 'err');
			return false;
		} finally {
			busy = false;
		}
	}
	async function save() {
		const f = form;
		if (!f) return;
		const body = { name: f.name.trim(), enabled: f.enabled, config: config(f) };
		const ok = await run(
			() =>
				f.id ? api('PATCH', `${path}/${f.id}`, body) : api('POST', path, { kind: f.kind, ...body }),
			f.id ? 'Trigger saved.' : 'Trigger added.'
		);
		if (ok) form = null;
	}
	const toggle = (t: TriggerView) =>
		run(
			() => api('PATCH', `${path}/${t.id}`, { enabled: !t.enabled }),
			t.enabled ? `${t.name} is off.` : `${t.name} is on.`
		);
	async function remove(t: TriggerView) {
		if (
			!(await confirmDialog(`Delete the trigger "${t.name}"?`, { okLabel: 'Delete', danger: true }))
		)
			return;
		await run(() => api('DELETE', `${path}/${t.id}`), 'Trigger deleted.');
	}
	async function dryRun(kind: TriggerKind, cfg: Record<string, unknown>, key: string) {
		dryBusy = true;
		dryFor = key;
		try {
			dry = (await api<{ result: DryRunResult }>('POST', `${path}/dry-run`, { kind, config: cfg }))
				.result;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			dryBusy = false;
		}
	}

	function describe(t: TriggerView): string {
		const c = t.config as Record<string, unknown>;
		switch (t.kind) {
			case 'welcome':
				return `"${c.message}"${c.onlyFirstVisit ? ' · first visit only' : ''}`;
			case 'broadcast':
				return `${(c.messages as string[]).length} message${(c.messages as string[]).length === 1 ? '' : 's'} every ${c.everyMinutes} min · at least ${c.minPlayers} on`;
			case 'empty_reset':
				return `to ${mapLabel(data.catalog, String(c.map))} after ${c.afterMinutes} min empty`;
			case 'risk_kick': {
				const rules = [
					c.vacBans && 'VAC ban',
					c.gameBans && 'game ban',
					c.minAccountDays &&
						`account under ${c.minAccountDays} days${c.privateProfiles ? ' or private' : ''}`,
					c.bannedElsewhere && 'banned elsewhere in the org',
					c.watchlist && 'watchlist'
				].filter(Boolean);
				return `${rules.join(', ')}${c.spareReserved ? ' · spares reserved slots' : ''}`;
			}
		}
	}
</script>

<div class="mb-4 flex flex-wrap items-center gap-2">
	<p class="text-[13px] text-mist-400">
		Rules the worker evaluates on every observation{data.server.demo ? ' of the demo server' : ''}:
		a join is acted on within a couple of seconds. Every action is queued, delivered, and recorded
		below and in the audit trail as
		<span class="chip">trigger</span>. Dry-run a rule against the last 24 hours before it touches
		anyone.
	</p>
</div>

{#if admin}
	<div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
		{#each KINDS as k (k.kind)}
			<button
				type="button"
				class="cursor-pointer panel text-left transition hover:border-accent/60"
				onclick={() => open(k.kind)}
			>
				<div class="caps text-accent">+ {k.label}</div>
				<div class="mt-1 text-[13px] text-mist-400">{k.blurb}</div>
			</button>
		{/each}
	</div>
{/if}

<div class="space-y-3">
	{#each data.triggers as t (t.id)}
		<div class="panel {t.enabled ? '' : 'opacity-70'}">
			<div class="flex flex-wrap items-start gap-3">
				<label class="mt-0.5 inline-flex items-center gap-2">
					<input
						type="checkbox"
						checked={t.enabled}
						disabled={!admin || busy}
						onchange={() => toggle(t)}
					/>
				</label>
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-semibold">{t.name}</span>
						<Badge tone={t.enabled ? 'ok' : ''}>{t.enabled ? 'on' : 'off'}</Badge>
						<Badge tone="info">{label(t.kind)}</Badge>
					</div>
					<div class="mt-1 text-[13px] text-mist-400">{describe(t)}</div>
					<div class="mt-1 text-[12px] text-mist-600">
						{#if t.lastFiredAt}Last fired {fmtTime(t.lastFiredAt)} · {t.lastResult}{:else if t.lastResult}{t.lastResult}{:else}Never
							fired.{/if}
						{#if t.fireCount}· {t.fireCount} action{t.fireCount === 1 ? '' : 's'} so far{/if}
					</div>
				</div>
				{#if admin}
					<span class="inline-flex flex-wrap gap-1.5">
						<button
							class="btn btn-sm"
							disabled={dryBusy}
							onclick={() => dryRun(t.kind, t.config, t.id)}>Dry run</button
						>
						<button class="btn btn-sm" onclick={() => open(t.kind, t)}>Edit</button>
						<button class="btn btn-sm btn-danger" disabled={busy} onclick={() => remove(t)}
							>Delete</button
						>
					</span>
				{/if}
			</div>
			{#if dry && dryFor === t.id && !form}
				<div class="mt-3 rounded-ctl border border-black bg-ink-950 p-3">
					{@render dryResult(dry)}
				</div>
			{/if}
		</div>
	{:else}
		<div class="panel text-center text-mist-600">
			No triggers yet.{#if admin}
				Pick one above to start.{/if}
		</div>
	{/each}
</div>

{#snippet dryResult(r: DryRunResult)}
	<div class="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
		<b>Dry run, last 24 h:</b>
		<span
			>would have fired <b class={r.fires ? 'text-warn' : 'text-ok'}>{r.fires}</b> time{r.fires ===
			1
				? ''
				: 's'}</span
		>
		<button type="button" class="ml-auto btn btn-sm btn-ghost" onclick={() => (dry = null)}
			>✕</button
		>
	</div>
	{#if r.items.length}
		<ul class="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[12px]">
			{#each r.items as it, i (i)}
				<li><span class="text-mist-600">{fmtTime(it.at)}</span> {it.text}</li>
			{/each}
			{#if r.fires > r.items.length}<li class="text-mist-600">
					… and {r.fires - r.items.length} more
				</li>{/if}
		</ul>
	{/if}
	{#each r.notes as n (n)}<p class="note">{n}</p>{/each}
{/snippet}

{#if form}
	{@const f = form}
	<Modal
		title="{f.id ? 'Edit' : 'New'} · {label(f.kind)}"
		wide={f.kind === 'empty_reset'}
		onclose={() => (form = null)}
	>
		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
				<label class="block"
					><span class="field-label">Name</span><input
						class="input"
						type="text"
						bind:value={f.name}
						maxlength="60"
						required
					/></label
				>
				<label class="flex items-end gap-2 pb-2.5 text-[13px]"
					><input type="checkbox" bind:checked={f.enabled} /> Enabled</label
				>
			</div>

			{#if f.kind === 'welcome'}
				<label class="block"
					><span class="field-label">Message</span><input
						class="input"
						type="text"
						bind:value={f.message}
						maxlength="200"
						required
					/></label
				>
				<label class="flex items-center gap-2 text-[13px]"
					><input type="checkbox" bind:checked={f.onlyFirstVisit} /> Only on a player's first visit to
					this server</label
				>
				<p class="note">
					Placeholders: <span class="chip">{'{name}'}</span> <span class="chip">{'{server}'}</span>
					<span class="chip">{'{map}'}</span> <span class="chip">{'{players}'}</span>
					<span class="chip">{'{max}'}</span>. Sent as a whisper, so only that player sees it.
				</p>
			{:else if f.kind === 'broadcast'}
				<label class="block"
					><span class="field-label">Messages (one per line, sent in turn)</span><textarea
						class="min-h-[100px] input"
						bind:value={f.messages}
						required></textarea></label
				>
				<div class="grid grid-cols-2 gap-3">
					<label class="block"
						><span class="field-label">Every (minutes)</span><input
							class="input"
							type="number"
							min="1"
							max="1440"
							bind:value={f.everyMinutes}
							required
						/></label
					>
					<label class="block"
						><span class="field-label">Only with at least (players)</span><input
							class="input"
							type="number"
							min="0"
							max="1000"
							bind:value={f.minPlayers}
						/></label
					>
				</div>
				<p class="note">
					Same placeholders as the welcome whisper, minus <span class="chip">{'{name}'}</span>.
					Broadcasts are limited to 200 characters.
				</p>
			{:else if f.kind === 'empty_reset'}
				<MapPicker bind:this={picker} serverId={id} catalog={data.catalog} />
				<div class="grid grid-cols-2 gap-3">
					<label class="block"
						><span class="field-label">After empty for (minutes)</span><input
							class="input"
							type="number"
							min="1"
							max="1440"
							bind:value={f.afterMinutes}
							required
						/></label
					>
					<label class="block"
						><span class="field-label">Cooldown between resets (minutes)</span><input
							class="input"
							type="number"
							min="1"
							max="1440"
							bind:value={f.cooldownMinutes}
						/></label
					>
				</div>
				<p class="note">
					Fires when nobody has been on for that long and the server is on a different map or mode.
					With a rotation the target is set as next and the match ended; without one the map is
					requested directly.
				</p>
			{:else}
				<div class="space-y-1.5 text-[13px]">
					<label class="flex items-center gap-2"
						><input type="checkbox" bind:checked={f.bannedElsewhere} /> Banned on another server in this
						organisation</label
					>
					<label class="flex items-center gap-2"
						><input type="checkbox" bind:checked={f.watchlist} /> On the watchlist</label
					>
					<label class="flex items-center gap-2 {data.steam ? '' : 'text-mist-600'}"
						><input type="checkbox" bind:checked={f.vacBans} disabled={!data.steam} /> Any VAC ban on
						record</label
					>
					<label class="flex items-center gap-2 {data.steam ? '' : 'text-mist-600'}"
						><input type="checkbox" bind:checked={f.gameBans} disabled={!data.steam} /> Any game ban on
						record</label
					>
					<div class="flex flex-wrap items-center gap-2 {data.steam ? '' : 'text-mist-600'}">
						Steam account younger than
						<input
							class="input w-20 text-right"
							type="number"
							min="0"
							max="3650"
							bind:value={f.minAccountDays}
							disabled={!data.steam}
						/>
						days (0 = off)
					</div>
					<label class="flex items-center gap-2 pl-5 {data.steam ? '' : 'text-mist-600'}"
						><input
							type="checkbox"
							bind:checked={f.privateProfiles}
							disabled={!data.steam || !f.minAccountDays}
						/> …and treat private profiles (age unknown) as too young</label
					>
					<label class="flex items-center gap-2"
						><input type="checkbox" bind:checked={f.spareReserved} /> Never kick players with a reserved
						slot</label
					>
				</div>
				<label class="block"
					><span class="field-label">Kick reason shown to the player</span><input
						class="input"
						type="text"
						bind:value={f.reason}
						maxlength="200"
					/></label
				>
				{#if !data.steam}
					<p class="note text-warn">
						Steam lookup is off (STEAM_API_KEY), so only the ban-list and watchlist rules can run.
					</p>
				{:else}
					<p class="note">
						Steam data is fetched when a player first appears and refreshed daily. Kicks land in the
						audit trail with the rule that matched.
					</p>
				{/if}
			{/if}

			{#if dry && dryFor === 'form'}
				<div class="rounded-ctl border border-black bg-ink-950 p-3">{@render dryResult(dry)}</div>
			{/if}

			<div class="flex flex-wrap justify-end gap-2 pt-2">
				<button
					type="button"
					class="mr-auto btn"
					disabled={dryBusy}
					onclick={() => dryRun(f.kind, config(f), 'form')}
					>{dryBusy ? 'Replaying…' : 'Dry run (last 24 h)'}</button
				>
				<button type="button" class="btn" data-close onclick={() => (form = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}
					>{f.id ? 'Save' : 'Add trigger'}</button
				>
			</div>
		</form>
	</Modal>
{/if}

<div class="mt-4 panel">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<span class="label-sm mb-0">Recent actions</span>
		<span class="text-[12.5px] text-mist-600"
			>what the rules did, newest first · <b>unknown</b> means sent with no answer, never retried on its
			own</span
		>
	</div>
	<div class="table-wrap">
		<table>
			<thead
				><tr
					><th>When</th><th>Rule</th><th>Action</th><th>Target</th><th>State</th><th>Result</th></tr
				></thead
			>
			<tbody>
				{#each deliveries as d (d.id)}
					<tr>
						<td class="whitespace-nowrap">{fmtTime(d.createdAt)}</td>
						<td>{d.triggerName}</td>
						<td class="font-mono text-[12px]">{d.action}</td>
						<td class="font-mono text-[12px]">{d.target}</td>
						<td><Badge tone={stateTone(d.state)}>{d.state}</Badge></td>
						<td class="text-mist-400">{d.outcome}</td>
					</tr>
				{:else}
					<tr><td colspan="6" class="py-6 text-center text-mist-600">No actions yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
