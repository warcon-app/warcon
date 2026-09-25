<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtAgo, fmtSpan, fmtTime, mapLabel } from '$lib/format';
	import { can } from '$lib/capabilities';
	import { isSteamId } from '$lib/steam-profiles';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import MapPicker from '$lib/components/MapPicker.svelte';
	import RowMenu from '$lib/components/RowMenu.svelte';
	import SortHeader from '$lib/components/SortHeader.svelte';
	import { TableSort, matches } from '$lib/table.svelte';
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
	let admin = $derived(can(data.server.caps, 'automation.manage'));
	let path = $derived(`/api/servers/${encodeURIComponent(id)}/triggers`);

	/** A risk_kick rule's score threshold, 0 when off; rules saved with a level read as 20 or 50. */
	const kickAtScoreOf = (c: Record<string, unknown>): number =>
		typeof c.kickAtScore === 'number'
			? c.kickAtScore
			: c.kickAtLevel === 'high'
				? 50
				: c.kickAtLevel === 'medium'
					? 20
					: 0;

	/** The last actions the rules took and what became of them; refreshed as deliveries happen. */
	let deliveries = $state<OutboxView[]>([]);
	let deliverySearch = $state('');
	const deliverySort = new TableSort<OutboxView>({
		when: { by: (d) => d.createdAt, dir: 'desc' },
		rule: { by: (d) => d.triggerName },
		action: { by: (d) => d.action },
		target: { by: (d) => d.target },
		state: { by: (d) => d.state },
		result: { by: (d) => d.outcome }
	});
	/** Narrow the table to one rule (by name, so a deleted rule's rows still group) or one state. */
	let ruleFilter = $state('');
	let stateFilter = $state<'' | OutboxView['state']>('');
	const STATES: OutboxView['state'][] = [
		'delivered',
		'failed',
		'skipped',
		'unknown',
		'pending',
		'sending'
	];
	let ruleNames = $derived([...new Set(deliveries.map((d) => d.triggerName))].sort());
	let deliveryRows = $derived(
		deliverySort.sorted(
			deliveries.filter(
				(d) =>
					(!ruleFilter || d.triggerName === ruleFilter) &&
					(!stateFilter || d.state === stateFilter) &&
					matches(deliverySearch, d.triggerName, d.action, d.target, d.state, d.outcome)
			)
		)
	);
	let actionsPanel = $state<HTMLElement>();
	/** From a failing rule's row to its deliveries: set the rule filter and bring the table up. */
	function seeActions(t: TriggerView) {
		ruleFilter = t.name;
		stateFilter = '';
		deliverySearch = '';
		actionsPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
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

	// The kinds, grouped by what they act on for the Add menu. `needs` is what a kind must have
	// before it can run here, shown in the menu and at the top of its editor; '' when it can.
	type Group = 'Messages' | 'Players' | 'Server';
	const KINDS: { kind: TriggerKind; group: Group; label: string; blurb: string }[] = [
		{
			kind: 'welcome',
			group: 'Messages',
			label: 'Welcome whisper',
			blurb: 'Whisper players as they join, or once they pick a faction.'
		},
		{
			kind: 'faction_change',
			group: 'Messages',
			label: 'Faction change whisper',
			blurb: 'Whisper players who switch sides.'
		},
		{
			kind: 'broadcast',
			group: 'Messages',
			label: 'Scheduled broadcast',
			blurb: 'Rotate through messages every few minutes while people are on.'
		},
		{
			kind: 'restart_notice',
			group: 'Messages',
			label: 'Restart notice',
			blurb: 'Warn players before the 24-hour restart and tell them when it lands.'
		},
		{
			kind: 'match_broadcast',
			group: 'Messages',
			label: 'Match broadcast',
			blurb: 'Announce who won when a match ends, and the map as the next one starts.'
		},
		{
			kind: 'risk_kick',
			group: 'Players',
			label: 'Kick on connect risk',
			blurb: 'Kick joiners the panel already distrusts, before they get a slot.'
		},
		{
			kind: 'name_filter',
			group: 'Players',
			label: 'Name filter',
			blurb: 'Kick or flag joiners whose name uses characters or words this server does not allow.'
		},
		{
			kind: 'ping_kick',
			group: 'Players',
			label: 'High ping kick',
			blurb: 'Kick players whose ping stays too high for a configured time.'
		},
		{
			kind: 'team_kill',
			group: 'Players',
			label: 'Team kill limit',
			blurb: 'Whisper a player about team kills and kick them past a limit.'
		},
		{
			kind: 'kill_rate',
			group: 'Players',
			label: 'Kill rate watch',
			blurb: 'Flag players who get kills too fast, or too many headshots, for staff to check.'
		},
		{
			kind: 'seed_reward',
			group: 'Players',
			label: 'Seeding reward',
			blurb: 'Give players who stay while the server is quiet a reserved slot.'
		},
		{
			kind: 'empty_reset',
			group: 'Server',
			label: 'Empty-server map reset',
			blurb: 'Put an empty server back on a chosen map after a while.'
		}
	];
	const GROUPS: Group[] = ['Messages', 'Players', 'Server'];
	/** The outbox action as the table shows it: a flag sends nothing to the game, so it reads as one. */
	const actionLabel = (action: string) =>
		action === 'name_flag' || action === 'kill_rate_flag' ? 'flag' : action;
	const label = (kind: TriggerKind) => KINDS.find((k) => k.kind === kind)?.label ?? kind;
	const blurb = (kind: TriggerKind) => KINDS.find((k) => k.kind === kind)?.blurb ?? '';
	/** Why a kind cannot run on this server yet, or '' when it can. */
	let needs = $derived((kind: TriggerKind): string => {
		switch (kind) {
			case 'team_kill':
			case 'kill_rate':
				return data.feed
					? ''
					: 'Needs the kill feed, which is off on this server. Turn it on under Config.';
			case 'risk_kick':
				return data.steam
					? ''
					: 'Steam lookup is off on this panel, so only the ban-list and watchlist rows can run.';
			case 'seed_reward':
				return canSlotHere || canSlotOrg
					? ''
					: 'Saving needs the Reserved slots capability (or Org reserved slots, for a slot on every server) as well as Automation.';
			default:
				return '';
		}
	});
	/**
	 * what a Seeding reward may hand out: a slot on this server (Reserved slots) or on every server
	 * (Org reserved slots)
	 */
	let canSlotHere = $derived(can(data.server.caps, 'slots.manage'));
	let canSlotOrg = $derived(can(data.server.caps, 'lists.reserve'));
	/** A kind that lacks what it needs stays in the menu, greyed, with the reason in a few words. */
	const short = (kind: TriggerKind): string =>
		kind === 'team_kill' || kind === 'kill_rate'
			? 'needs the kill feed'
			: kind === 'risk_kick'
				? 'needs a Steam key'
				: '';
	let addOpen = $state(false);

	// The status lines count up on their own: a minute clock, only while the page is open.
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	interface Health {
		/** the newest delivery for the rule failed, with nothing delivered since */
		failing: boolean;
		latest: string;
		outcome: string;
		/** deliveries since midnight, or in the loaded window when that is shorter */
		count: number;
	}
	/**
	 * What the loaded deliveries say about each rule. A trigger's own `lastResult` records the
	 * intent ("Kicking 2 players"), not what became of it, so health comes from the outbox rows the
	 * page already has: the server's last 40. A busy rule can push a quiet rule's rows out of that
	 * window, in which case the quiet rule shows its plain "Fired" line, which is honest.
	 */
	let health = $derived.by(() => {
		const byRule = new Map<string, Health>();
		const rows = [...deliveries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const since = Math.max(new Date(now).setHours(0, 0, 0, 0), windowStart);
		for (const d of rows) {
			if (!d.triggerId) continue;
			const h = byRule.get(d.triggerId);
			const today = Date.parse(d.createdAt) >= since ? 1 : 0;
			if (h) h.count += today;
			else
				byRule.set(d.triggerId, {
					failing: d.state === 'failed',
					latest: d.createdAt,
					outcome: d.outcome,
					count: today
				});
		}
		return byRule;
	});
	/** when the oldest loaded delivery happened; the counts cannot see past it */
	let windowStart = $derived(
		deliveries.reduce((min, d) => Math.min(min, Date.parse(d.createdAt)), Infinity)
	);
	/** the outbox route's page size: fewer rows than that means the window holds everything */
	const OUTBOX_PAGE = 40;
	let coversToday = $derived(
		deliveries.length < OUTBOX_PAGE || windowStart <= new Date(now).setHours(0, 0, 0, 0)
	);
	/** "31 today", or "31 in the last 3 h" when the loaded window is shorter than the day */
	const countLine = (h: Health) =>
		coversToday ? `${h.count} today` : `${h.count} in the last ${fmtSpan(now - windowStart)}`;
	let failingCount = $derived(data.triggers.filter((t) => health.get(t.id)?.failing).length);
	let lastAction = $derived(
		deliveries.reduce<string | null>(
			(max, d) => (!max || d.createdAt > max ? d.createdAt : max),
			null
		)
	);
	let onlyFailing = $state(false);
	let rows = $derived(
		onlyFailing ? data.triggers.filter((t) => health.get(t.id)?.failing) : data.triggers
	);

	interface Form {
		id: string | null;
		kind: TriggerKind;
		name: string;
		enabled: boolean;
		message: string;
		onlyFirstVisit: boolean;
		afterFaction: boolean;
		messages: string;
		everyMinutes: number;
		minPlayers: number;
		maxPlayers: number | null;
		afterMinutes: number;
		cooldownMinutes: number;
		vacBans: boolean;
		gameBans: boolean;
		maxBanAgeDays: number;
		maxPingMs: number;
		durationSeconds: number;
		minAccountDays: number;
		privateProfiles: boolean;
		bannedElsewhere: boolean;
		watchlist: boolean;
		kickAtScore: number;
		spareReserved: boolean;
		reason: string;
		leadMinutes: number;
		leadMessage: string;
		repeatMinutes: number;
		endMessage: string;
		startMessage: string;
		warnAt: number;
		warnMessage: string;
		kickAt: number;
		kickReason: string;
		lowAt: number;
		untilFull: boolean;
		fullAt: number | null;
		minutes: number;
		windowDays: number;
		slotDays: number;
		slotScope: 'server' | 'org';
		replaceExisting: boolean;
		characters: 'off' | 'latin' | 'ascii';
		extraScripts: string[];
		allowSymbols: boolean;
		minLetters: number;
		builtinWords: boolean;
		blocked: string;
		allowed: string;
		nameAction: 'kick' | 'alert';
		windowMinutes: number;
		maxKills: number;
		headshotPct: number;
		headshotMinKills: number;
	}
	/** The alphabets a Latin policy can let in, by the name the rule stores and the one people use. */
	const SCRIPTS: [string, string][] = [
		['Cyrillic', 'Cyrillic'],
		['Greek', 'Greek'],
		['Arabic', 'Arabic'],
		['Hebrew', 'Hebrew'],
		['Thai', 'Thai'],
		['Devanagari', 'Devanagari'],
		['Han', 'Chinese'],
		['Hiragana', 'Hiragana'],
		['Katakana', 'Katakana'],
		['Hangul', 'Korean']
	];
	let form = $state<Form | null>(null);
	/**
	 * Placeholder chips insert into the message field the admin last had the caret in, or the first
	 * one in the form; typing `{faction}` by hand is the commonest thing to get wrong.
	 */
	let formEl = $state<HTMLFormElement>();
	let lastField: HTMLInputElement | HTMLTextAreaElement | null = null;
	const isText = (el: unknown): el is HTMLInputElement | HTMLTextAreaElement =>
		el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text');
	function insert(token: string) {
		const el =
			lastField?.isConnected && !lastField.disabled
				? lastField
				: formEl?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
						'textarea:not([disabled]):not([data-plain]), input[type=text]:not([disabled]):not([name=name])'
					);
		if (!el) return;
		const at = el.selectionStart ?? el.value.length;
		el.setRangeText(`{${token}}`, at, el.selectionEnd ?? at, 'end');
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.focus();
	}
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

	/** The editor for a new rule of a kind, an existing rule, or a copy of one (`copy`). */
	function open(kind: TriggerKind, t?: TriggerView, copy = false) {
		const c = (t?.config ?? {}) as Record<string, unknown>;
		const s = (k: string, d: string) => (typeof c[k] === 'string' ? (c[k] as string) : d);
		const n = (k: string, d: number) => (typeof c[k] === 'number' ? (c[k] as number) : d);
		const b = (k: string, d: boolean) => (typeof c[k] === 'boolean' ? (c[k] as boolean) : d);
		form = {
			id: copy ? null : (t?.id ?? null),
			kind,
			name: t ? (copy ? `${t.name} (copy)` : t.name) : label(kind),
			enabled: t?.enabled ?? true,
			message: s(
				'message',
				kind === 'faction_change'
					? 'You are now fighting for {faction}, {name}.'
					: kind === 'restart_notice'
						? 'Scheduled restart: the server restarts when this round ends. Rejoin in a minute or two.'
						: kind === 'seed_reward'
							? 'Thanks for seeding {server}, {name}: you have a reserved slot until {until}.'
							: 'Welcome to {server}, {name}! Read the rules with /rules.'
			),
			onlyFirstVisit: b('onlyFirstVisit', false),
			afterFaction: b('afterFaction', false),
			messages: Array.isArray(c.messages)
				? (c.messages as string[]).join('\n')
				: 'Join our Discord for events and support.\nNo team-killing. Admins are watching.',
			everyMinutes: n('everyMinutes', 15),
			minPlayers: n('minPlayers', 1),
			maxPlayers: typeof c.maxPlayers === 'number' ? c.maxPlayers : null,
			afterMinutes: n('afterMinutes', 20),
			cooldownMinutes: n('cooldownMinutes', 30),
			vacBans: b('vacBans', true),
			gameBans: b('gameBans', false),
			maxBanAgeDays: n('maxBanAgeDays', 0),
			maxPingMs: n('maxPingMs', 200),
			durationSeconds: n('durationSeconds', 60),
			minAccountDays: n('minAccountDays', 0),
			privateProfiles: b('privateProfiles', false),
			bannedElsewhere: b('bannedElsewhere', true),
			watchlist: b('watchlist', false),
			kickAtScore: kickAtScoreOf(c),
			spareReserved: b('spareReserved', true),
			reason: s(
				'reason',
				kind === 'name_filter'
					? 'Your name is not allowed on this server: {why}.'
					: kind === 'ping_kick'
						? 'Ping too high for too long.'
						: 'Your account does not meet this server’s requirements.'
			),
			leadMinutes: n('leadMinutes', 30),
			leadMessage: s(
				'leadMessage',
				'Scheduled restart in about {minutes} minutes, at the end of the round then in progress.'
			),
			repeatMinutes: n('repeatMinutes', 0),
			endMessage: s('endMessage', 'Match over: {faction} wins on {previous} · {scores}'),
			startMessage: s('startMessage', 'New match on {map}. Good luck!'),
			warnAt: n('warnAt', 2),
			warnMessage: s(
				'warnMessage',
				'Careful, {name}: that was a team kill ({count} this session).'
			),
			kickAt: n('kickAt', 4),
			kickReason: s('kickReason', 'Team killing ({count} this session).'),
			lowAt: n('lowAt', 20),
			untilFull: b('untilFull', true),
			fullAt: typeof c.fullAt === 'number' ? c.fullAt : null,
			minutes: n('minutes', 60),
			windowDays: n('windowDays', 7),
			slotDays: n('slotDays', 7),
			replaceExisting: b('replaceExisting', false),
			// a rule saved before the scope existed hands out org-wide slots; a new one, this server's
			slotScope: c.scope === 'server' ? 'server' : t ? 'org' : canSlotHere ? 'server' : 'org',
			characters: c.characters === 'ascii' || c.characters === 'off' ? c.characters : 'latin',
			extraScripts: Array.isArray(c.extraScripts) ? (c.extraScripts as string[]) : [],
			allowSymbols: b('allowSymbols', false),
			minLetters: n('minLetters', 0),
			builtinWords: b('builtinWords', !t),
			blocked: Array.isArray(c.blocked) ? (c.blocked as string[]).join('\n') : '',
			allowed: Array.isArray(c.allowed) ? (c.allowed as string[]).join('\n') : '',
			nameAction: c.action === 'alert' ? 'alert' : 'kick',
			windowMinutes: n('windowMinutes', 5),
			maxKills: n('maxKills', 25),
			headshotPct: n('headshotPct', 70),
			headshotMinKills: n('headshotMinKills', 15)
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

	const dryLabel = (kind: TriggerKind) =>
		kind === 'restart_notice'
			? 'Preview next cycle'
			: kind === 'name_filter'
				? 'Dry run, past players'
				: kind === 'ping_kick'
					? 'Check dry-run limits'
					: 'Dry run, last 24 h';
	const lines = (text: string) =>
		text
			.split(/[\n,]/)
			.map((w) => w.trim())
			.filter(Boolean);
	// A cleared number input binds null, not '': an optional count is sent only when it is a number.
	function config(f: Form): Record<string, unknown> {
		switch (f.kind) {
			case 'welcome':
				return {
					message: f.message,
					onlyFirstVisit: f.onlyFirstVisit,
					afterFaction: f.afterFaction
				};
			case 'faction_change':
				return { message: f.message };
			case 'broadcast':
				return {
					messages: f.messages.split('\n'),
					everyMinutes: Number(f.everyMinutes),
					minPlayers: Number(f.minPlayers),
					maxPlayers: typeof f.maxPlayers === 'number' ? f.maxPlayers : null
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
					maxBanAgeDays: Number(f.maxBanAgeDays),
					minAccountDays: Number(f.minAccountDays),
					privateProfiles: f.privateProfiles,
					bannedElsewhere: f.bannedElsewhere,
					watchlist: f.watchlist,
					kickAtScore: Number(f.kickAtScore) || null,
					spareReserved: f.spareReserved,
					reason: f.reason
				};
			case 'name_filter':
				return {
					characters: f.characters,
					extraScripts: f.characters === 'latin' ? f.extraScripts : [],
					allowSymbols: f.allowSymbols,
					minLetters: Number(f.minLetters),
					builtinWords: f.builtinWords,
					blocked: lines(f.blocked),
					allowed: lines(f.allowed),
					action: f.nameAction,
					spareReserved: f.spareReserved,
					reason: f.reason
				};
			case 'ping_kick':
				return {
					maxPingMs: Number(f.maxPingMs),
					durationSeconds: Number(f.durationSeconds),
					reason: f.reason
				};
			case 'restart_notice':
				return {
					message: f.message,
					leadMinutes: Number(f.leadMinutes),
					leadMessage: f.leadMessage,
					repeatMinutes: Number(f.repeatMinutes),
					minPlayers: Number(f.minPlayers)
				};
			case 'match_broadcast':
				return {
					endMessage: f.endMessage,
					startMessage: f.startMessage,
					minPlayers: Number(f.minPlayers)
				};
			case 'team_kill':
				return {
					warnAt: Number(f.warnAt),
					warnMessage: f.warnMessage,
					kickAt: Number(f.kickAt),
					kickReason: f.kickReason
				};
			case 'kill_rate':
				return {
					windowMinutes: Number(f.windowMinutes),
					maxKills: Number(f.maxKills),
					headshotPct: Number(f.headshotPct),
					headshotMinKills: Number(f.headshotMinKills),
					cooldownMinutes: Number(f.cooldownMinutes)
				};
			case 'seed_reward':
				return {
					lowAt: Number(f.lowAt),
					untilFull: f.untilFull,
					fullAt: typeof f.fullAt === 'number' ? f.fullAt : null,
					minutes: Number(f.minutes),
					windowDays: Number(f.windowDays),
					slotDays: Number(f.slotDays),
					scope: f.slotScope,
					replaceExisting: f.replaceExisting,
					message: f.message
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
		if (await run(() => api('DELETE', `${path}/${t.id}`), 'Trigger deleted.'))
			if (dryFor === t.id) dry = null;
	}
	/** The result panel is titled with the rule it was run for; 'form' keys a run from the editor. */
	let dryTitle = $state('');
	async function dryRun(
		kind: TriggerKind,
		cfg: Record<string, unknown>,
		key: string,
		title: string
	) {
		dryBusy = true;
		dryFor = key;
		dryTitle = title;
		try {
			dry = (await api<{ result: DryRunResult }>('POST', `${path}/dry-run`, { kind, config: cfg }))
				.result;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			dryBusy = false;
		}
	}

	/** A dry run's lines with repeats folded: a broadcast replayed 96 times is one line, ×96. */
	function grouped(items: DryRunResult['items']): { at: string; text: string; n: number }[] {
		const out: { at: string; text: string; n: number }[] = [];
		for (const it of items) {
			const last = out[out.length - 1];
			if (last && last.text === it.text) last.n++;
			else out.push({ at: it.at, text: it.text, n: 1 });
		}
		return out;
	}

	/** The rule as one sentence; the list shows it, and the editor shows it live as "Reads as". */
	function describe(kind: TriggerKind, config: Record<string, unknown>): string {
		const c = config;
		switch (kind) {
			case 'welcome':
				return `"${c.message}"${c.afterFaction ? ' · after faction pick' : ' · on join'}${c.onlyFirstVisit ? ' · first visit only' : ''}`;
			case 'faction_change':
				return `"${c.message}"`;
			case 'broadcast':
				return `${(c.messages as string[]).length} message${(c.messages as string[]).length === 1 ? '' : 's'} every ${c.everyMinutes} min · ${typeof c.maxPlayers === 'number' ? `${c.minPlayers} to ${c.maxPlayers}` : `at least ${c.minPlayers}`} on`;
			case 'empty_reset':
				return `to ${c.map ? mapLabel(data.catalog, String(c.map)) : 'the chosen map'} after ${c.afterMinutes} min empty`;
			case 'risk_kick': {
				const banAge = c.maxBanAgeDays ? ` in the last ${c.maxBanAgeDays} days` : '';
				const rules = [
					c.vacBans && `VAC ban${banAge}`,
					c.gameBans && `game ban${banAge}`,
					c.minAccountDays &&
						`account under ${c.minAccountDays} days${c.privateProfiles ? ' or private' : ''}`,
					c.bannedElsewhere && 'banned elsewhere in the org',
					c.watchlist && 'watchlist',
					kickAtScoreOf(c) && `risk ${kickAtScoreOf(c)}+`
				].filter(Boolean);
				return `${rules.join(', ')}${c.spareReserved ? ' · spares reserved slots' : ''}`;
			}
			case 'name_filter': {
				const also = ((c.extraScripts as string[] | undefined) ?? []).map(
					(x) => SCRIPTS.find(([k]) => k === x)?.[1] ?? x
				);
				const blocked = ((c.blocked as string[] | undefined) ?? []).length;
				const allowed = ((c.allowed as string[] | undefined) ?? []).length;
				const lists = [
					c.builtinWords && 'built-in list',
					blocked && `${blocked} word${blocked === 1 ? '' : 's'}`
				].filter(Boolean);
				return [
					c.characters === 'ascii'
						? 'ASCII only'
						: c.characters === 'latin'
							? `${['Latin', ...also].join(', ')} letters`
							: '',
					c.characters !== 'off' && c.allowSymbols ? 'emoji and symbols allowed' : '',
					c.minLetters ? `at least ${c.minLetters} letters` : '',
					lists.length
						? `${lists.join(' and ')}${allowed ? `, ${allowed} exception${allowed === 1 ? '' : 's'}` : ''}`
						: '',
					c.action === 'alert' ? 'alert only' : 'kick',
					c.spareReserved ? 'spares reserved slots' : ''
				]
					.filter(Boolean)
					.join(' · ');
			}
			case 'ping_kick':
				return `ping over ${c.maxPingMs} ms for ${c.durationSeconds} s`;
			case 'restart_notice':
				return `"${c.message}"${c.leadMinutes ? ` · heads-up ${c.leadMinutes} min before` : ''}${c.repeatMinutes ? ` · again every ${c.repeatMinutes} min` : ''} · at least ${c.minPlayers} on`;
			case 'match_broadcast':
				return [
					c.endMessage ? `end: "${c.endMessage}"` : '',
					c.startMessage ? `start: "${c.startMessage}"` : ''
				]
					.filter(Boolean)
					.join(' · ')
					.concat(` · at least ${c.minPlayers} on`);
			case 'team_kill':
				return [
					c.warnAt ? `whisper from ${c.warnAt} team kill${c.warnAt === 1 ? '' : 's'}` : '',
					c.kickAt ? `kick at ${c.kickAt}` : ''
				]
					.filter(Boolean)
					.join(' · ')
					.concat(' · per session');
			case 'kill_rate':
				return [
					c.maxKills ? `${c.maxKills} kills` : '',
					c.headshotPct ? `${c.headshotPct}% headshots from ${c.headshotMinKills} kills` : ''
				]
					.filter(Boolean)
					.join(' or ')
					.concat(` in ${c.windowMinutes} min · flag only · again after ${c.cooldownMinutes} min`);
			case 'seed_reward':
				return `${c.minutes} min with ${c.lowAt} or fewer on${c.untilFull === false ? '' : `, staying until ${typeof c.fullAt === 'number' ? `${c.fullAt}+ on` : 'it fills'}`}, within ${c.windowDays} day${c.windowDays === 1 ? '' : 's'} · slot ${c.scope === 'server' ? 'here' : 'on every server'} for ${c.slotDays} day${c.slotDays === 1 ? '' : 's'}${c.replaceExisting ? ' · replaces an existing slot' : ''}${c.message ? ' · with a whisper' : ''}`;
		}
	}
</script>

<svelte:window
	onclick={() => (addOpen = false)}
	onkeydown={(e) => e.key === 'Escape' && (addOpen = false)}
/>

<p class="mb-4 text-[13px] text-mist-400">
	Rules act on {data.server.demo ? 'the demo server' : 'this server'} as things happen: a join, a kill,
	a quiet hour. Every action is recorded below and in the audit trail as
	<span class="chip">trigger</span>.
</p>

<div class="mb-3 flex flex-wrap items-start gap-3">
	<div class="min-w-0 grow">
		<span class="label-sm mb-0">Rules</span>
		<div class="mt-0.5 text-[12.5px] text-mist-400">
			{#if data.triggers.length}
				{data.triggers.length} rule{data.triggers.length === 1 ? '' : 's'} · {data.triggers.filter(
					(t) => t.enabled
				).length} on
				{#if lastAction}· last action <span title={fmtTime(lastAction)}
						>{fmtAgo(lastAction, now)}</span
					>{/if}
				{#if failingCount}
					· <button
						type="button"
						class="cursor-pointer text-danger underline decoration-danger/50 underline-offset-2 hover:decoration-danger"
						aria-pressed={onlyFailing}
						onclick={() => (onlyFailing = !onlyFailing)}
						>{failingCount} failing{onlyFailing ? ' · show all' : ''}</button
					>
				{/if}
			{:else}
				No rules on this server yet
			{/if}
		</div>
	</div>
	{#if admin}
		<div class="relative">
			<button
				type="button"
				class="btn gap-1.5 pr-2.5"
				aria-haspopup="menu"
				aria-expanded={addOpen}
				onclick={(e) => {
					e.stopPropagation();
					addOpen = !addOpen;
				}}
			>
				Add rule <span class="text-[10px] text-mist-600">▼</span>
			</button>
			{#if addOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<div
					class="absolute top-[calc(100%+6px)] right-0 z-40 min-w-[270px] rise rounded-card border border-black bg-ink-900 p-1 shadow-pop"
					role="menu"
					tabindex="-1"
					onclick={(e) => e.stopPropagation()}
				>
					{#each GROUPS as g (g)}
						<div class="px-3 pt-2 pb-1 caps text-mist-600">{g}</div>
						{#each KINDS.filter((k) => k.group === g) as k (k.kind)}
							<button
								type="button"
								class="menu-item {needs(k.kind) ? 'text-mist-600!' : ''}"
								role="menuitem"
								title={k.blurb}
								onclick={() => {
									addOpen = false;
									open(k.kind);
								}}
							>
								<span>{k.label}</span>
								{#if needs(k.kind) && short(k.kind)}
									<span class="ml-auto text-[11px] text-mist-600">{short(k.kind)}</span>
								{/if}
							</button>
						{/each}
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- A dry run from a row opens here, above the list, so the rows never change height. -->
{#if dry && dryFor !== 'form' && !form}
	<div class="mb-3 rounded-ctl border border-l-2 border-black border-l-accent bg-ink-900 p-3">
		{@render dryResult(dry, dryTitle)}
	</div>
{/if}

<div class="space-y-2">
	{#each rows as t (t.id)}
		{@const h = health.get(t.id)}
		<!-- An off row fades its contents, not the panel: opacity on the panel would fade the ⋯ menu
		     too and trap it under the next row. -->
		<div class="panel py-3.5">
			<div class="flex items-start gap-3">
				<button
					type="button"
					role="switch"
					aria-checked={t.enabled}
					aria-label="{t.name}: {t.enabled ? 'on' : 'off'}"
					class="mt-1 h-[18px] w-8 shrink-0 cursor-pointer rounded-full border border-black transition disabled:cursor-not-allowed {t.enabled
						? 'bg-accent'
						: 'bg-ink-700 opacity-60'}"
					disabled={!admin || busy}
					onclick={() => toggle(t)}
				>
					<span
						class="block h-3 w-3 rounded-full bg-ink-950 transition-transform {t.enabled
							? 'translate-x-[15px]'
							: 'translate-x-[2px]'}"
					></span>
				</button>
				<div class="min-w-0 flex-1 {t.enabled ? '' : 'opacity-60'}">
					<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
						{#if admin}
							<button
								type="button"
								class="cursor-pointer text-left font-semibold hover:text-white"
								onclick={() => open(t.kind, t)}>{t.name}</button
							>
						{:else}
							<span class="font-semibold">{t.name}</span>
						{/if}
						{#if h?.failing}<Badge tone="err">▲ failing</Badge>{/if}
						<span class="chip">{label(t.kind)}</span>
					</div>
					<div class="mt-0.5 line-clamp-2 text-[13px] text-mist-400">
						{describe(t.kind, t.config)}
					</div>
					<!-- One of four shapes, most urgent first: failing, off, fired, never fired. -->
					<div class="mt-0.5 text-[12px] {h?.failing ? 'text-mist-100' : 'text-mist-600'}">
						{#if h?.failing}
							Latest actions failed · <span class="font-mono text-[11.5px] text-mist-400"
								>{h.outcome}</span
							>
							· <span title={fmtTime(h.latest)}>{fmtAgo(h.latest, now)}</span>
							<button type="button" class="ml-1 btn btn-sm" onclick={() => seeActions(t)}
								>See actions</button
							>
						{:else if !t.enabled}
							Off · {#if t.lastFiredAt}last fired <span title={fmtTime(t.lastFiredAt)}
									>{fmtAgo(t.lastFiredAt, now)}</span
								>{:else}never fired{/if}
						{:else if t.lastFiredAt}
							Fired <span title={fmtTime(t.lastFiredAt)}>{fmtAgo(t.lastFiredAt, now)}</span>
							{#if h?.count}· {countLine(h)}{:else if t.fireCount}· {t.fireCount} action{t.fireCount ===
								1
									? ''
									: 's'} so far{/if}
						{:else}
							Never fired{#if needs(t.kind)}
								· {needs(t.kind)}{/if}
						{/if}
					</div>
				</div>
				{#if admin}
					<RowMenu label="Actions for {t.name}">
						<button
							type="button"
							class="menu-item"
							role="menuitem"
							disabled={dryBusy}
							onclick={() => dryRun(t.kind, t.config, t.id, t.name)}>{dryLabel(t.kind)}</button
						>
						<button type="button" class="menu-item" role="menuitem" onclick={() => open(t.kind, t)}
							>Edit</button
						>
						<button
							type="button"
							class="menu-item"
							role="menuitem"
							onclick={() => open(t.kind, t, true)}>Duplicate</button
						>
						<hr class="my-1 border-black" />
						<button
							type="button"
							class="menu-item text-danger!"
							role="menuitem"
							disabled={busy}
							onclick={() => remove(t)}>Delete</button
						>
					</RowMenu>
				{/if}
			</div>
		</div>
	{:else}
		<div class="flex flex-col items-center gap-3 panel py-7 text-center">
			{#if admin && !onlyFailing}
				<p class="text-mist-100">Most servers start with these two.</p>
				<div class="flex flex-wrap justify-center gap-2">
					<button type="button" class="btn btn-primary" onclick={() => open('welcome')}
						>+ Welcome whisper</button
					>
					<button type="button" class="btn" onclick={() => open('broadcast')}
						>+ Scheduled broadcast</button
					>
				</div>
				<p class="max-w-[52ch] text-[12.5px] text-mist-600">
					Or add any rule: {KINDS.filter((k) => k.kind !== 'welcome' && k.kind !== 'broadcast')
						.map((k) => k.label)
						.join(' · ')}.
				</p>
			{:else if onlyFailing}
				<p class="text-mist-600">No rule is failing.</p>
			{:else}
				<p class="text-mist-600">No rules on this server yet.</p>
			{/if}
		</div>
	{/each}
</div>

{#snippet placeholders(names: string[])}
	<div class="flex flex-wrap items-center gap-1 text-[12px] text-mist-600">
		<span class="mr-1">Insert</span>
		{#each names as n (n)}
			<button
				type="button"
				class="chip cursor-pointer text-mist-100 transition hover:bg-white/12"
				title="Insert {'{' + n + '}'} at the caret"
				onclick={() => insert(n)}>{'{' + n + '}'}</button
			>
		{/each}
	</div>
{/snippet}

{#snippet dryResult(r: DryRunResult, title: string)}
	<div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
		<span class="caps text-accent"
			>{r.kind === 'restart_notice' ? 'Next cycle' : 'Dry run'} · {title}</span
		>
		{#if r.kind === 'restart_notice'}
			<span
				><b class={r.fires ? 'text-warn' : 'text-ok'}>{r.fires}</b> broadcast{r.fires === 1
					? ''
					: 's'}</span
			>
		{:else if r.kind === 'name_filter'}
			<span
				>Everyone who has played here: would have matched <b
					class={r.fires ? 'text-warn' : 'text-ok'}>{r.fires}</b
				>
				name{r.fires === 1 ? '' : 's'}</span
			>
		{:else}
			<span
				>Replayed the last 24 h on this server: would have fired <b
					class={r.fires ? 'text-warn' : 'text-ok'}>{r.fires}</b
				>
				time{r.fires === 1 ? '' : 's'}</span
			>
		{/if}
		<button
			type="button"
			class="ml-auto btn btn-sm btn-ghost"
			aria-label="Close the dry run"
			onclick={() => (dry = null)}>✕</button
		>
	</div>
	{#if r.items.length}
		<ul class="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[12px]">
			{#each grouped(r.items) as it, i (i)}
				<li>
					<span class="text-mist-600">{fmtTime(it.at)}</span>
					{it.text}
					{#if it.n > 1}<span class="text-mist-600">×{it.n}</span>{/if}
				</li>
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
		wide={f.kind === 'empty_reset' || f.kind === 'name_filter'}
		onclose={() => (form = null)}
	>
		<form
			class="space-y-3"
			bind:this={formEl}
			onfocusin={(e) => {
				if (isText(e.target) && e.target.name !== 'name' && !e.target.dataset.plain)
					lastField = e.target;
			}}
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<p class="-mt-2 text-[13px] text-mist-400">{blurb(f.kind)}</p>
			{#if needs(f.kind)}<p class="note mb-0 text-warn">{needs(f.kind)}</p>{/if}
			<!-- Hidden, not unmounted, while the dry run shows: the map picker keeps its choice. -->
			<div class="space-y-3" class:hidden={dry && dryFor === 'form'}>
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
					<label class="block"
						><span class="field-label">Name</span><input
							class="input"
							type="text"
							name="name"
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
					<fieldset class="space-y-2">
						<legend class="field-label">Whisper</legend>
						<input class="input" type="text" bind:value={f.message} maxlength="200" required />
						{@render placeholders(['name', 'faction', 'server', 'map', 'players', 'max'])}
					</fieldset>
					<fieldset class="space-y-1.5 text-[13px]">
						<legend class="field-label">When</legend>
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={f.afterFaction} /> Wait until the player has picked
							a faction</label
						>
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={f.onlyFirstVisit} /> Only on a player's first visit
							to this server</label
						>
					</fieldset>
					<p class="note">Sent as a whisper, so only that player sees it.</p>
				{:else if f.kind === 'faction_change'}
					<fieldset class="space-y-2">
						<legend class="field-label">Whisper</legend>
						<input class="input" type="text" bind:value={f.message} maxlength="200" required />
						{@render placeholders([
							'name',
							'faction',
							'previous',
							'server',
							'map',
							'players',
							'max'
						])}
					</fieldset>
					<p class="note">
						Fires when a player moves from one faction to another, not on their first pick after
						joining.
					</p>
				{:else if f.kind === 'broadcast'}
					<fieldset class="space-y-2">
						<legend class="field-label">Messages, one per line, sent in turn</legend>
						<textarea class="min-h-[100px] input" bind:value={f.messages} required></textarea>
						{@render placeholders(['server', 'map', 'players', 'max'])}
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">When</legend>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
							Every
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="1440"
								bind:value={f.everyMinutes}
								aria-label="Every, minutes"
								required
							/>
							min, with at least
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="1000"
								bind:value={f.minPlayers}
								aria-label="At least, players"
							/>
							and at most
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="1000"
								bind:value={f.maxPlayers}
								aria-label="At most, players"
								placeholder="any"
							/>
							players on
						</div>
					</fieldset>
					<p class="note">
						Blank for no ceiling; a fill-the-server message can stop once it has. Broadcasts are
						limited to 200 characters.
					</p>
				{:else if f.kind === 'empty_reset'}
					<fieldset class="space-y-2">
						<legend class="field-label">Reset to</legend>
						<MapPicker bind:this={picker} serverId={id} catalog={data.catalog} />
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">When</legend>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
							After the server has been empty for
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="1440"
								bind:value={f.afterMinutes}
								aria-label="After empty for, minutes"
								required
							/>
							min, at most once every
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="1440"
								bind:value={f.cooldownMinutes}
								aria-label="Cooldown between resets, minutes"
							/>
							min
						</div>
					</fieldset>
					<p class="note">
						Fires when nobody has been on for that long and the server is on a different map or
						mode. With a rotation the target is set as next and the match ended; without one the map
						is requested directly.
					</p>
				{:else if f.kind === 'restart_notice'}
					<fieldset class="space-y-2">
						<legend class="field-label">Heads-up, before the window opens</legend>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
							Send
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="1439"
								bind:value={f.leadMinutes}
								aria-label="Heads-up, minutes before"
							/>
							min before <span class="text-mist-600">(0 turns the heads-up off)</span>
						</div>
						<input
							class="input"
							type="text"
							bind:value={f.leadMessage}
							maxlength="200"
							aria-label="Heads-up message"
							disabled={!Number(f.leadMinutes)}
						/>
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">Once the window is open</legend>
						<input
							class="input"
							type="text"
							bind:value={f.message}
							maxlength="200"
							aria-label="Message once the window is open"
							required
						/>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
							Repeat every
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="1440"
								bind:value={f.repeatMinutes}
								aria-label="Repeat every, minutes"
							/>
							min while the round runs on <span class="text-mist-600">(0 sends it once)</span>
						</div>
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">Only with at least</legend>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="1000"
								bind:value={f.minPlayers}
								aria-label="At least, players"
							/>
							players on
						</div>
					</fieldset>
					{@render placeholders(['minutes', 'uptime', 'server', 'map', 'players', 'max'])}
					<p class="note">
						The game restarts 24 hours after it started, once the round then in progress ends.
					</p>
				{:else if f.kind === 'match_broadcast'}
					<fieldset class="space-y-2">
						<legend class="field-label">When a match ends</legend>
						<input
							class="input"
							type="text"
							bind:value={f.endMessage}
							maxlength="200"
							aria-label="Message when a match ends"
							placeholder="Leave empty to say nothing"
						/>
						{@render placeholders([
							'faction',
							'score',
							'scores',
							'cap',
							'previous',
							'mvp',
							'top',
							'map',
							'server',
							'players'
						])}
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">As the next one starts</legend>
						<input
							class="input"
							type="text"
							bind:value={f.startMessage}
							maxlength="200"
							aria-label="Message as the next match starts"
							placeholder="Leave empty to say nothing"
						/>
						{@render placeholders(['map', 'previous', 'server', 'players', 'max'])}
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">Only with at least</legend>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="1000"
								bind:value={f.minPlayers}
								aria-label="At least, players"
							/>
							players on
						</div>
					</fieldset>
					<p class="note">
						A match ends when the map changes or the faction scores fall back to zero, so a manual
						end or map change counts too; {'{faction}'} is whoever led at that moment (tied factions are
						named together). Sent one poll after the round ends, a second or two on a busy server and
						up to half a minute on a quiet one.
					</p>
				{:else if f.kind === 'risk_kick'}
					<fieldset class="space-y-1.5 text-[13px]">
						<legend class="field-label">Kick when the player is</legend>
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={f.bannedElsewhere} /> banned on another server in
							this organisation</label
						>
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={f.watchlist} /> on the watchlist</label
						>
						<div
							class="grid grid-cols-1 gap-x-4 gap-y-1.5 border-t border-black pt-2 sm:grid-cols-[1fr_auto] {data.steam
								? ''
								: 'text-mist-600'}"
						>
							<div class="space-y-1.5">
								<label class="flex items-center gap-2"
									><input type="checkbox" bind:checked={f.vacBans} disabled={!data.steam} /> VAC banned</label
								>
								<label class="flex items-center gap-2"
									><input type="checkbox" bind:checked={f.gameBans} disabled={!data.steam} /> game banned</label
								>
								{#if f.vacBans || f.gameBans}
									<div
										class="flex flex-wrap items-center gap-2 pl-5 {data.steam
											? ''
											: 'text-mist-600'}"
									>
										Only bans from the last
										<input
											class="input w-24 text-right"
											type="number"
											min="0"
											max="36500"
											bind:value={f.maxBanAgeDays}
											disabled={!data.steam}
										/>
										days (0 = since forever)
									</div>
								{/if}
								<div class="flex flex-wrap items-center gap-2">
									on a Steam account under
									<input
										class="input w-20 text-right"
										type="number"
										min="0"
										max="3650"
										bind:value={f.minAccountDays}
										aria-label="Steam account younger than, days"
										disabled={!data.steam}
									/>
									days old <span class="text-mist-600">(0 turns it off)</span>
								</div>
								<label class="flex items-center gap-2 pl-5"
									><input
										type="checkbox"
										bind:checked={f.privateProfiles}
										disabled={!data.steam || !f.minAccountDays}
									/> and treat private profiles, whose age is unknown, as too young</label
								>
							</div>
							<p
								class="max-w-[22ch] text-[12px] text-mist-600 sm:border-l sm:border-ink-700 sm:pl-3"
							>
								From Steam, fetched when a player first appears and refreshed daily.
							</p>
						</div>
						<label class="flex flex-wrap items-center gap-2 border-t border-black pt-2"
							>at advisory risk score
							<input
								class="input w-[80px]"
								type="number"
								min="0"
								max="100"
								bind:value={f.kickAtScore}
							/>
							or more, as the players table shows it (0 is off)</label
						>
					</fieldset>
					<fieldset class="space-y-1.5 text-[13px]">
						<legend class="field-label">Never kick</legend>
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={f.spareReserved} /> players with a reserved slot</label
						>
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">Kick reason, shown to the player</legend>
						<input class="input" type="text" bind:value={f.reason} maxlength="200" />
					</fieldset>
					<p class="note">Kicks land in the audit trail with the rule that matched.</p>
				{:else if f.kind === 'name_filter'}
					<div class="grid grid-cols-1 items-start gap-x-6 gap-y-3 sm:grid-cols-2">
						<div class="space-y-3">
							<fieldset class="space-y-2 text-[13px]">
								<legend class="field-label">Characters a name may use</legend>
								<select class="input" bind:value={f.characters} aria-label="Character policy">
									<option value="off">Any</option>
									<option value="latin">Latin letters (keeps José, Müller)</option>
									<option value="ascii">ASCII only (what a US keyboard types)</option>
								</select>
								{#if f.characters === 'latin'}
									<div class="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
										<span class="text-mist-400">and also</span>
										{#each SCRIPTS as [value, name] (value)}
											<label class="flex items-center gap-1.5"
												><input type="checkbox" {value} bind:group={f.extraScripts} />
												{name}</label
											>
										{/each}
									</div>
								{/if}
								{#if f.characters !== 'off'}
									<label class="flex flex-wrap items-center gap-2 border-t border-black pt-2"
										><input type="checkbox" bind:checked={f.allowSymbols} /> Allow emoji and symbols
										<span class="text-mist-600">(★ 【 】 and the like)</span></label
									>
								{/if}
								<div class="flex flex-wrap items-center gap-2">
									At least
									<input
										class="input w-20 text-right"
										type="number"
										min="0"
										max="10"
										bind:value={f.minLetters}
										aria-label="Minimum letters in a name"
									/>
									letters <span class="text-mist-600">(0 turns it off; catches ____ and ....)</span>
								</div>
								{#if f.characters !== 'off'}
									<p class="text-[12px] text-mist-600">
										Digits, spaces and keyboard punctuation always pass.
									</p>
								{/if}
							</fieldset>
							<fieldset class="space-y-1.5 text-[13px]">
								<legend class="field-label">When a name matches</legend>
								<label class="flex items-center gap-2"
									><input type="radio" value="kick" bind:group={f.nameAction} /> Kick the player</label
								>
								<label class="flex flex-wrap items-center gap-2"
									><input type="radio" value="alert" bind:group={f.nameAction} /> Alert only
									<span class="text-mist-600">(audit trail and Discord, nobody is kicked)</span
									></label
								>
								<label class="flex items-center gap-2 border-t border-black pt-2"
									><input type="checkbox" bind:checked={f.spareReserved} /> Never players with a reserved
									slot</label
								>
							</fieldset>
						</div>
						<div class="space-y-3 sm:border-l sm:border-black sm:pl-6">
							<fieldset class="space-y-2 text-[13px]">
								<legend class="field-label">Words a name may not contain</legend>
								<label class="flex flex-wrap items-center gap-2"
									><input type="checkbox" bind:checked={f.builtinWords} /> The built-in English list
									<span class="text-mist-600">(slurs and hate terms; add swearing yourself)</span
									></label
								>
								<textarea
									class="input font-mono text-[12.5px]"
									rows="7"
									data-plain
									bind:value={f.blocked}
									aria-label="Blocked words, one per line"
									placeholder="one word per line"></textarea>
								<p class="text-[12px] text-mist-600">
									Caught through case, leetspeak (n4z1), look-alike letters, stretching and spelling
									out (n.a.z.i). Letters, digits and spaces; 200 at most.
								</p>
							</fieldset>
							<fieldset class="space-y-2 text-[13px]">
								<legend class="field-label">Except</legend>
								<textarea
									class="input font-mono text-[12.5px]"
									rows="3"
									data-plain
									bind:value={f.allowed}
									aria-label="Allowed words, one per line"></textarea>
								<p class="text-[12px] text-mist-600">
									Names or parts of names that would match but are fine here.
								</p>
							</fieldset>
						</div>
					</div>
					{#if f.nameAction === 'kick'}
						<fieldset class="space-y-2">
							<legend class="field-label">Kick reason, shown to the player</legend>
							<input class="input" type="text" bind:value={f.reason} maxlength="200" />
							{@render placeholders(['why', 'name', 'server'])}
							<p class="text-[12px] text-mist-600">
								{'{why}'} names the kind of fault ("it uses characters outside the Latin alphabet"), never
								the word.
							</p>
						</fieldset>
					{/if}
					<p class="note">
						Names are checked as players join; a player who renames mid-session is caught on their
						next join. Run the dry run before turning a word list loose.
					</p>
				{:else if f.kind === 'ping_kick'}
					<fieldset class="space-y-2">
						<legend class="field-label">Kick when ping stays above</legend>
						<div class="flex flex-wrap items-center gap-2 text-[13px]">
							<input
								class="input w-24 text-right"
								type="number"
								min="1"
								max="2000"
								bind:value={f.maxPingMs}
								aria-label="Maximum ping, milliseconds"
								required
							/>
							ms for at least
							<input
								class="input w-24 text-right"
								type="number"
								min="1"
								max="3600"
								bind:value={f.durationSeconds}
								aria-label="High ping duration, seconds"
								required
							/>
							seconds
						</div>
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">Kick reason, shown to the player</legend>
						<input class="input" type="text" bind:value={f.reason} maxlength="200" />
					</fieldset>
					<p class="note">
						The timer starts on the first high-ping sample. It resets when ping drops to the limit
						or below, is unavailable, the player leaves, or the player list cannot be sampled on
						time.
					</p>
				{:else if f.kind === 'team_kill'}
					<fieldset class="space-y-2">
						<legend class="field-label">Whisper</legend>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
							From
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="100"
								bind:value={f.warnAt}
								aria-label="Whisper from, team kills"
							/>
							team kills, on every one after <span class="text-mist-600">(0 turns it off)</span>
						</div>
						<input
							class="input"
							type="text"
							bind:value={f.warnMessage}
							maxlength="200"
							aria-label="Whisper"
							disabled={!Number(f.warnAt)}
						/>
						{@render placeholders(['name', 'victim', 'count', 'server', 'map'])}
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">Kick</legend>
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
							At
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="100"
								bind:value={f.kickAt}
								aria-label="Kick at, team kills"
							/>
							team kills <span class="text-mist-600">(0 turns it off)</span>
						</div>
						<input
							class="input"
							type="text"
							bind:value={f.kickReason}
							maxlength="200"
							aria-label="Kick reason"
							disabled={!Number(f.kickAt)}
						/>
					</fieldset>
					<p class="note">
						Team kills come from the game's kill feed and are counted per player within their
						current session.
					</p>
				{:else if f.kind === 'kill_rate'}
					<fieldset class="space-y-1.5 text-[13px]">
						<legend class="field-label">Flag a player at</legend>
						<div class="flex flex-wrap items-center gap-2">
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="1000"
								bind:value={f.maxKills}
								aria-label="Flag at, kills in the window"
							/>
							kills <span class="text-mist-600">(0 turns it off)</span>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							or
							<input
								class="input w-20 text-right"
								type="number"
								min="0"
								max="100"
								bind:value={f.headshotPct}
								aria-label="Flag at, percent headshots"
							/>
							% headshots, from
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="1000"
								bind:value={f.headshotMinKills}
								aria-label="Headshot share judged from, kills"
								disabled={!Number(f.headshotPct)}
							/>
							kills <span class="text-mist-600">(0 % turns it off)</span>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							within
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="60"
								bind:value={f.windowMinutes}
								aria-label="Within, minutes"
								required
							/>
							minutes
						</div>
					</fieldset>
					<fieldset class="space-y-1.5 text-[13px]">
						<legend class="field-label">Flag the same player again after</legend>
						<div class="flex flex-wrap items-center gap-2">
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="1440"
								bind:value={f.cooldownMinutes}
								aria-label="Flag again after, minutes"
								required
							/>
							minutes
						</div>
					</fieldset>
					<p class="note">
						Counts kills with hand-held weapons from the kill feed. A flag goes to the audit trail
						and Discord; nobody is kicked.
					</p>
				{:else if f.kind === 'seed_reward'}
					<fieldset class="space-y-1.5 text-[13px]">
						<legend class="field-label">Counts as seeding</legend>
						<div class="flex flex-wrap items-center gap-2">
							Being on with at most
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="1000"
								bind:value={f.lowAt}
								aria-label="Counts as seeding: at most, players on"
								required
							/>
							players on
						</div>
						<label class="flex items-center gap-2"
							><input type="checkbox" bind:checked={f.untilFull} /> and only once the server has filled
							with the player still on</label
						>
						<div
							class="flex flex-wrap items-center gap-2 pl-5 {f.untilFull ? '' : 'text-mist-600'}"
						>
							Filled means at least
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="1000"
								bind:value={f.fullAt}
								aria-label="Filled means at least, players"
								placeholder="limit"
								disabled={!f.untilFull}
							/>
							players <span class="text-mist-600">(blank for the server's own limit)</span>
						</div>
					</fieldset>
					<fieldset class="space-y-1.5 text-[13px]">
						<legend class="field-label">Reward</legend>
						<div class="flex flex-wrap items-center gap-2">
							<input
								class="input w-24 text-right"
								type="number"
								min="1"
								max="129600"
								bind:value={f.minutes}
								aria-label="Seed time needed, minutes"
								required
							/>
							min of seed time within the last
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="90"
								bind:value={f.windowDays}
								aria-label="Counted over the last, days"
								required
							/>
							days earns a reserved slot for
							<input
								class="input w-20 text-right"
								type="number"
								min="1"
								max="365"
								bind:value={f.slotDays}
								aria-label="Reserved slot lasts, days"
								required
							/>
							days
						</div>
						<div class="flex flex-wrap gap-x-4 gap-y-1">
							<label class="flex items-center gap-2 {canSlotHere ? '' : 'text-mist-600'}"
								><input
									type="radio"
									bind:group={f.slotScope}
									value="server"
									disabled={!canSlotHere}
								/> on this server only</label
							>
							<label class="flex items-center gap-2 {canSlotOrg ? '' : 'text-mist-600'}"
								><input type="radio" bind:group={f.slotScope} value="org" disabled={!canSlotOrg} />
								on every server in the organisation</label
							>
						</div>
						<label class="flex items-center gap-2">
							<input type="checkbox" bind:checked={f.replaceExisting} /> Replace an existing reserved
							slot with the newly earned one
						</label>
					</fieldset>
					<fieldset class="space-y-2">
						<legend class="field-label">Whisper on the grant, blank for none</legend>
						<input class="input" type="text" bind:value={f.message} maxlength="200" />
						{@render placeholders(['name', 'server', 'minutes', 'until', 'days', 'players', 'max'])}
					</fieldset>
					<p class="note">
						With the box ticked, seed time stays pending until the server has filled with the player
						still on; leave before that and it is forfeited. Unticked, every low minute counts as it
						passes. A slot on this server only goes on this server's own reserved-slot list; one on
						every server goes on the organisation's, which this server applies at once and the
						others at their next sync. Either lapses on its own and can be earned again. Players who
						already hold a reserved slot here are skipped unless replacement is enabled; replacement
						removes the active entry in the selected list and grants a fresh one. Seed time below
						the reward threshold carries into later games; granting the reward resets that player's
						reward counter without erasing their historical seeding statistics.
					</p>
				{/if}

				<div class="rounded-ctl border border-black bg-ink-950 px-3 py-2 text-[13px]">
					<span class="mr-2 caps text-accent">Reads as</span>
					<span class="text-mist-100">{describe(f.kind, config(f))}</span>
				</div>
			</div>

			{#if dry && dryFor === 'form'}
				<div class="rounded-ctl border border-black bg-ink-950 p-3">
					{@render dryResult(dry, f.name)}
				</div>
			{/if}

			<div class="flex flex-wrap justify-end gap-2 pt-2">
				<button
					type="button"
					class="mr-auto btn"
					disabled={dryBusy}
					onclick={() =>
						dry && dryFor === 'form' ? (dry = null) : dryRun(f.kind, config(f), 'form', f.name)}
					>{dryBusy
						? 'Working…'
						: dry && dryFor === 'form'
							? 'Back to the form'
							: dryLabel(f.kind)}</button
				>
				<button type="button" class="btn" data-close onclick={() => (form = null)}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={busy}
					>{f.id ? 'Save' : 'Add rule'}</button
				>
			</div>
		</form>
	</Modal>
{/if}

{#if data.triggers.length || deliveries.length}
	<div class="mt-4 scroll-mt-4 panel" bind:this={actionsPanel}>
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<span class="label-sm mb-0">Recent actions</span>
			<span class="text-[12.5px] text-mist-600">what the rules did, newest first</span>
			<div class="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
				<select
					class="input w-auto pr-[30px] {ruleFilter ? 'border-accent' : ''}"
					aria-label="Only this rule"
					bind:value={ruleFilter}
				>
					<option value="">All rules</option>
					{#each ruleNames as name (name)}<option value={name}>{name}</option>{/each}
				</select>
				<select
					class="input w-auto pr-[30px] {stateFilter ? 'border-accent' : ''}"
					aria-label="Only this state"
					bind:value={stateFilter}
				>
					<option value="">Any state</option>
					{#each STATES as s (s)}<option value={s}>{s}</option>{/each}
				</select>
				<input
					class="input w-full sm:w-52"
					type="search"
					placeholder="Filter by action, target, result…"
					aria-label="Filter recent actions"
					bind:value={deliverySearch}
				/>
			</div>
		</div>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<SortHeader sort={deliverySort} key="when">When</SortHeader>
						<SortHeader sort={deliverySort} key="rule">Rule</SortHeader>
						<SortHeader sort={deliverySort} key="action">Action</SortHeader>
						<SortHeader sort={deliverySort} key="target">Target</SortHeader>
						<SortHeader sort={deliverySort} key="state">State</SortHeader>
						<SortHeader sort={deliverySort} key="result">Result</SortHeader>
					</tr>
				</thead>
				<tbody>
					{#each deliveryRows as d (d.id)}
						<tr>
							<td class="whitespace-nowrap">{fmtTime(d.createdAt)}</td>
							<td>{d.triggerName}</td>
							<td class="font-mono text-[12px]">{actionLabel(d.action)}</td>
							<td class="font-mono text-[12px]"
								>{#if isSteamId(d.target)}<a class="link" href="/server/{id}/players/{d.target}"
										>{d.target}</a
									>{:else}{d.target}{/if}</td
							>
							<td
								><Badge
									tone={stateTone(d.state)}
									title={d.state === 'unknown'
										? 'Sent, no answer from the game. Not retried.'
										: undefined}>{d.state}</Badge
								></td
							>
							<td class="text-mist-400">{d.outcome}</td>
						</tr>
					{:else}
						<tr
							><td colspan="6" class="py-6 text-center text-mist-600"
								>{deliveries.length ? 'Nothing matches.' : 'No actions yet.'}</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/if}
