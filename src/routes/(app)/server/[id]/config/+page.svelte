<script lang="ts">
	import { api, rconGet, rconPost, errorMessage, ApiError } from '$lib/api';
	import { can } from '$lib/capabilities';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import ConfigForm from '$lib/components/ConfigForm.svelte';
	import TickReward from '$lib/components/TickReward.svelte';
	import { sponsor as banners, loadSponsor } from '$lib/sponsor.svelte';
	import { getScalar, parseIni, setScalarInText } from '$lib/config-doc';
	import { lockedKeys, S_SESSION } from '$lib/config-fields';
	import { EVENT_FEED_SECTION, eventFeedLines, usesEventFeed } from '$lib/feed-setup';
	import { fmtAgo, fmtNum, fmtTime } from '$lib/format';
	import type { FeedState } from '$lib/feed-health';
	import {
		feedDiagnosis,
		isPanel,
		type FeedDiagnosis,
		type FeedFault,
		type FeedReport
	} from '$lib/feed-report';
	import type { ConfigDoc, ConfigResult, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let admin = $derived(can(data.server.caps, 'config.apply'));

	let tick = $state(24);
	let tickMin = $state(18);
	let tickMax = $state(30);
	let tickKnown = $state(false);
	let sponsor = $state('');
	let sponsorShown = $derived(banners[id] ?? '');
	let doc = $state<ConfigDoc | null>(null);
	let text = $state('');
	let force = $state(false);
	let docError = $state('');
	let result = $state<ConfigResult | null>(null);
	let failure = $state('');
	let lineErrors = $state<{ line?: number; section?: string; key?: string; message?: string }[]>(
		[]
	);
	let busy = $state(false);
	let mode = $state<'form' | 'raw'>('form');

	let readOnly = $derived(!admin || !doc || !doc.writable);

	// The kill feed: the game posts every kill to Warcon once [WDServerFeed] Url and Token are set
	// in its config. The token is the server's identity on that route; org owners mint and see it.
	interface FeedSetup {
		configured: boolean;
		url: string;
		token: string;
		feedAt: string | null;
		startedAt: string | null;
		tokenAt: string | null;
		state: FeedState;
	}
	let feed = $state<FeedSetup | null>(null);
	let feedBusy = $state(false);
	let feedPath = $derived(`/api/servers/${encodeURIComponent(id)}/feed`);
	async function loadFeed() {
		try {
			feed = await api<FeedSetup>('GET', feedPath);
		} catch {
			feed = null;
		}
	}
	async function feedAction(fn: () => Promise<unknown>, done: string) {
		feedBusy = true;
		try {
			await fn();
			toast(done, 'ok');
			await loadFeed();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			feedBusy = false;
		}
	}
	// CL-516586 on: the feed is a list of endpoints in the RCON block that RCON cannot write, so
	// the host pastes the lines into the file.
	let eventFeed = $derived(usesEventFeed(doc?.sections));
	let feedLines = $derived(
		feed?.token ? eventFeedLines(feed.url, feed.token, data.server.name) : ''
	);
	/**
	 * One click: mint the token; on a build that reads [WDServerFeed], write both keys into the
	 * config document and apply.
	 */
	async function configureFeed() {
		const writable = !readOnly;
		feedBusy = true;
		try {
			feed = await api<FeedSetup>('POST', feedPath);
		} catch (err) {
			toast(errorMessage(err), 'err');
			feedBusy = false;
			return;
		}
		feedBusy = false;
		if (eventFeed)
			toast(
				'Token created. Paste the lines shown into ServerSettings.ini on the host, then restart the server.',
				'ok'
			);
		else if (writable) await writeFeedConfig();
		else
			toast(
				'Token created. The config document cannot be written from here, so set [WDServerFeed] Url and Token on the host by hand.',
				'ok'
			);
		await loadFeed();
	}
	async function rotateFeed() {
		if (
			!(await confirmDialog(
				`Replace the token? The game keeps posting with the old one until ${eventFeed ? 'the new lines are in its file' : 'the config is rewritten'} and the server restarts, and those posts will be refused.`,
				{ okLabel: 'Replace', danger: true }
			))
		)
			return;
		await feedAction(
			() => api('POST', feedPath),
			eventFeed
				? 'Token replaced. Paste the new lines on the host and restart the server.'
				: 'Token replaced. Write it to the config again.'
		);
	}
	async function disableFeed() {
		if (
			!(await confirmDialog(
				'Turn the kill feed off? Kills already stored stay; the game’s posts will be refused until a new token is written to its config.',
				{ okLabel: 'Turn off', danger: true }
			))
		)
			return;
		await feedAction(() => api('DELETE', feedPath), 'Kill feed turned off.');
	}
	async function writeFeedConfig() {
		if (!feed?.token || !doc) return;
		if (
			dirty &&
			!(await confirmDialog(
				'You have other unapplied config edits. Apply them to the server together with the kill feed settings?'
			))
		)
			return;
		text = setScalarInText(text, 'WDServerFeed', 'Url', feed.url);
		text = setScalarInText(text, 'WDServerFeed', 'Token', feed.token);
		await runConfig('configApply');
		if (!failure)
			toast('Kill feed configured. The game starts posting after its next restart.', 'ok');
	}
	async function copyFeed(value: string, what: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast(`${what} copied.`, 'ok');
		} catch {
			window.prompt(`Copy the ${what.toLowerCase()}:`, value);
		}
	}
	const feedAge = (iso: string) => {
		const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
		return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : fmtTime(iso);
	};
	$effect(() => {
		void loadFeed();
	});

	// What the game says about its feed (Season 2's GET /v1/feed, $lib/feed-report): read for those
	// who may apply the config, once the document shows a Season 2 build, and again on request.
	let report = $state<FeedReport | null>(null);
	let reportAt = $state('');
	let reportError = $state('');
	/** the build does not serve the route */
	let reportUnserved = $state(false);
	let reportBusy = $state(false);
	let reportAsked = false;
	async function readReport() {
		reportBusy = true;
		try {
			const next = await rconGet<FeedReport>(id, 'feed');
			// The panel's verdict, read after the report and before it is shown: one read earlier
			// (the page's first, or one from before the game restarted) has not seen the batches the
			// report counts, and would make them look taken in under another server's token.
			await loadFeed();
			report = next;
			reportAt = new Date().toISOString();
			reportError = '';
		} catch (err) {
			if (err instanceof ApiError && err.code === 'no_route') reportUnserved = true;
			else reportError = errorMessage(err);
		} finally {
			reportBusy = false;
		}
	}
	$effect(() => {
		if (admin && eventFeed && !reportAsked) {
			reportAsked = true;
			void readReport();
		}
	});
	let diagnosis = $derived(report && feed ? feedDiagnosis(report, feed.url, feed.state) : null);
	/** The fault in two lines: what is wrong, and what to do on the host. */
	const FAULTS: Record<FeedFault, (d: FeedDiagnosis) => [string, string]> = {
		off: () => [
			'The server started without a feed.',
			"bEventFeedEnabled=True was not in its file when it last started: add this panel's lines and restart the server."
		],
		empty: () => [
			'The feed is on, but lists no endpoint.',
			"Add this panel's EventFeedEndpoints line and restart the server."
		],
		elsewhere: (d) => [
			`The server's file lists ${d.others} endpoint${d.others === 1 ? '' : 's'}, none of them this panel.`,
			"Add this panel's line beside them (the game takes up to four) and restart the server."
		],
		path: (d) => [
			'The Url does not end in /api/ingest/events.',
			`The game posts to a page of this panel, which answers ${d.endpoint?.lastHttpStatus}: lines copied before 15 October 2026 named the site alone. Copy the line again, put it in place of the old one and restart the server.`
		],
		forbidden: () => [
			'This panel refuses the posts (403).',
			'Most often the Url has the wrong path: it must end in /api/ingest/events. Copy the line again, put it in place of the old one and restart the server.'
		],
		token: () => [
			"The token in the server's file is not this server's.",
			'Most often a line from before Replace token: only the newest token is taken. Copy the line again, put it in place of the old one and restart the server.'
		],
		panel: (d) => [
			`This panel answers the game with an error (${d.endpoint?.lastHttpStatus}).`,
			'Nothing to change on the host. If it lasts, tell whoever runs this panel.'
		],
		refused: (d) => [
			`This panel refuses the posts (${d.endpoint?.lastHttpStatus}).`,
			'Copy the line again, put it in place of the old one and restart the server.'
		],
		unreachable: () => [
			'The game cannot reach this panel.',
			"Its posts get no answer at all: check the Url's scheme and address against this panel's line."
		],
		otherToken: () => [
			"The game's posts reach this panel, but not as this server.",
			"They are taken in under another server's token, most likely a line copied from another server's card. Copy this server's line in place of it and restart the server."
		]
	};
	let pinned = $derived(doc ? lockedKeys(doc.sections) : []);
	let dirty = $derived(!!doc && text !== doc.text);

	async function loadDoc(opts: { keepResult?: boolean } = {}) {
		if (!opts.keepResult) {
			result = null;
			failure = '';
			lineErrors = [];
		}
		try {
			doc = await rconGet<ConfigDoc>(id, 'config');
			text = doc.text;
			docError = '';
		} catch (err) {
			doc = null;
			text = '';
			docError = errorMessage(err);
		}
	}
	async function reload() {
		if (dirty && !(await confirmDialog('Reload from the server and drop your unapplied edits?')))
			return;
		await loadDoc();
	}
	function discard() {
		if (doc) text = doc.text;
		failure = '';
		lineErrors = [];
	}
	async function copyText() {
		try {
			await navigator.clipboard.writeText(text);
			toast('Config copied to the clipboard.', 'ok');
		} catch {
			toast('Could not copy; select the raw file and copy it by hand.', 'err');
		}
	}
	function download() {
		const blob = new Blob([text], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `ServerSettings-${data.server.name.replace(/[^\w.-]+/g, '_')}.ini`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	// The banner is shared with the server header; a forced read follows an apply.
	async function loadBanner(force = false) {
		await loadSponsor(id, force);
		sponsor = banners[id] ?? '';
	}
	async function loadTick() {
		try {
			const st = await rconGet<Status>(id, 'status');
			if (st.scoreTickMin) tickMin = st.scoreTickMin;
			if (st.scoreTickMax) tickMax = st.scoreTickMax;
			if (st.scoreTick !== null) {
				tick = st.scoreTick;
				tickKnown = true;
			}
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	$effect(() => {
		void Promise.all([loadTick(), loadBanner(), loadDoc()]);
	});

	async function saveTick() {
		try {
			const r = await rconPost<{ message?: string }>(id, 'settings', { scoreTick: tick });
			toast(r?.message || 'Score tick saved.', 'ok');
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	// The game has no live route for the banner (real listeners answer PUT /v1/sponsor with
	// "PUT is not supported"), so, like the official console, this writes ServerImageURL into the
	// config document and applies it. Any other unapplied form edits go with it, as they would
	// from the Apply button below.
	async function saveSponsor() {
		if (readOnly) return;
		if (
			dirty &&
			!(await confirmDialog(
				'You have other unapplied config edits. Apply them to the server together with the sponsor image?'
			))
		)
			return;
		text = setScalarInText(text, S_SESSION, 'ServerImageURL', sponsor.trim());
		await runConfig('configApply');
		// On a refusal (for example a host that is not on the server's image allow-list) runConfig
		// has already shown the reason; keep what was typed so it can be corrected.
		if (failure) return;
		await loadBanner(true);
	}
	const nameIn = (t: string) => getScalar(parseIni(t), S_SESSION, 'ServerName');
	const nameless = (t: string) => setScalarInText(t, S_SESSION, 'ServerName', '');
	/**
	 * While a Live server name rule keeps the name, the document changes under an open page about
	 * once a minute. A conflict where that line is all that changed since the page loaded, and not one
	 * this page edited, is applied again over the newer revision with the name the rule wrote.
	 */
	async function overTheName(): Promise<ConfigResult | null> {
		if (!doc || !data.liveName || nameIn(text) !== nameIn(doc.text)) return null;
		const live = await rconGet<ConfigDoc>(id, 'config');
		if (nameless(live.text) !== nameless(doc.text)) return null;
		const merged = setScalarInText(text, S_SESSION, 'ServerName', nameIn(live.text) ?? '');
		const r = await rconPost<ConfigResult>(id, 'configApply', {
			text: merged,
			revision: live.revision,
			force: false
		});
		if (!r.conflict) text = merged;
		return r;
	}
	async function runConfig(action: 'configValidate' | 'configApply') {
		busy = true;
		result = null;
		failure = '';
		lineErrors = [];
		try {
			let r = await rconPost<ConfigResult>(
				id,
				action,
				action === 'configApply' ? { text, revision: doc?.revision, force } : { text }
			);
			if (r.conflict) r = (await overTheName()) ?? r;
			if (r.conflict) {
				failure = `${r.errorMessage || 'The config changed on the server since you loaded it.'} Reload to see the current version, or tick Force to overwrite.`;
				return;
			}
			if (!r.ok) {
				failure = r.errorMessage || 'Rejected.';
				lineErrors = r.errors || [];
				return;
			}
			result = r;
			if (action === 'configApply' && doc) {
				doc.revision = r.revision;
				toast(`Config applied (revision ${r.revision}).`, 'ok');
				// Re-read so the change marks and revision reflect what the server actually kept.
				await loadDoc({ keepResult: true });
			} else {
				toast('Config is valid.', 'ok');
			}
		} catch (err) {
			failure = errorMessage(err);
			const body =
				err instanceof ApiError
					? (err.data as { error?: { body?: { errors?: { line?: number; message?: string }[] } } })
							?.error?.body
					: null;
			lineErrors = body?.errors || [];
		} finally {
			busy = false;
			if (failure) toast(lineErrors[0]?.message || failure, 'err');
		}
	}
	const PIP: Record<string, string> = {
		applied: 'bg-ok/15 text-ok',
		'next-match': 'bg-info/15 text-info',
		'next-restart': 'bg-warn/15 text-warn',
		pending: 'bg-white/10 text-mist-400',
		shadowed: 'bg-override/15 text-override'
	};
</script>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<div class="panel">
		<span class="label-sm">Score tick (KOTH ScorePeriod)</span>
		<div class="flex items-center gap-3">
			<span class="text-mist-400">{tickMin}s</span>
			<input
				type="range"
				class="grow"
				min={tickMin}
				max={tickMax}
				step="1"
				bind:value={tick}
				disabled={!admin || !data.features.liveSettings}
				onchange={saveTick}
			/>
			<span class="text-mist-400">{tickMax}s</span>
			<output class="w-10 font-mono">{tickKnown ? `${tick}s` : '—'}</output>
		</div>
		<TickReward seconds={tickKnown ? tick : null} class="mt-2" />
		<p class="note">
			{#if data.features.liveSettings}Live route (PATCH /v1/settings).{:else}This server build has
				no live settings route; set ScorePeriod in the document below instead.{/if}
			Faster ticks reduce the cash multiplier; the game clamps to its allowed range.
		</p>
	</div>
	<div class="panel">
		<span class="label-sm">Sponsor image</span>
		<form
			class="join w-full"
			onsubmit={(e) => {
				e.preventDefault();
				void saveSponsor();
			}}
		>
			<input
				class="input"
				type="url"
				placeholder="https://…/banner.png (1024×256)"
				bind:value={sponsor}
				disabled={readOnly}
			/>
			<button class="btn btn-primary" type="submit" disabled={readOnly || busy}>Apply</button>
		</form>
		{#if sponsorShown}<img
				src={sponsorShown}
				alt=""
				class="mt-3 max-w-full rounded-card border border-black"
				referrerpolicy="no-referrer"
			/>{/if}
		<p class="note">
			The banner beside this server in the browser. Direct link to a 1024×256 PNG/JPEG on the
			server's image allow-list (catbox.moe, imgbb.com, postimg.cc). Written to the config document
			as ServerImageURL and applied like any other setting; the server fetches and checks the image
			before advertising it, so the result reads as pending until that finishes.
			{#if docError}No config document on this server, so the banner cannot be changed from here.{:else if doc && !doc.writable}The
				config document is read-only, so the banner cannot be changed from here.{/if}
		</p>
	</div>
</div>

<div class="mt-4 panel">
	<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
		<span class="label-sm mb-0">Kill feed</span>
		{#if feed}
			<!-- $lib/feed-health: a token is not a feed; what came since the game started says whether it works. -->
			{#if !feed.configured}
				<span class="badge">off</span>
			{:else if feed.state === 'silent'}
				<span class="badge bg-warn/15 text-warn">silent</span>
				<span class="text-[12.5px] text-mist-400"
					>nothing since the server started {fmtAgo(feed.startedAt!)} · {feed.feedAt
						? `last batch ${fmtTime(feed.feedAt)}`
						: 'no batch received yet'}</span
				>
			{:else if feed.state === 'waiting'}
				<span class="badge bg-info/15 text-info">waiting</span>
				<span class="text-[12.5px] text-mist-400"
					>the token is newer than the server's start: the game reads the lines when it next starts</span
				>
			{:else if feed.state === 'starting'}
				<span class="badge">on</span>
				<span class="text-[12.5px] text-mist-600"
					>the server started {fmtAgo(feed.startedAt!)}: its first batch comes within a few minutes</span
				>
			{:else}
				<span class="badge bg-ok/15 text-ok">on</span>
				<span class="text-[12.5px] text-mist-600"
					>{feed.feedAt ? `last batch ${feedAge(feed.feedAt)}` : 'no batch received yet'}</span
				>
			{/if}
		{/if}
		{#if data.server.manager && feed}
			<span class="ml-auto inline-flex flex-wrap gap-1.5">
				{#if feed.configured}
					<button class="btn btn-sm" disabled={feedBusy} onclick={rotateFeed}>Replace token</button>
					<button class="btn btn-sm btn-danger" disabled={feedBusy} onclick={disableFeed}
						>Turn off</button
					>
				{:else}
					<button
						class="btn btn-sm btn-primary"
						disabled={feedBusy || busy || !doc}
						onclick={configureFeed}>Configure</button
					>
				{/if}
			</span>
		{/if}
	</div>
	{#if feed?.configured && feed.state === 'silent' && eventFeed}
		<div class="mb-3 rounded-ctl border border-warn/30 bg-warn/10 p-3 text-[13px]">
			{#if diagnosis?.fault}
				<!-- what the game's own report says is wrong ($lib/feed-report) -->
				{@const [what, todo] = FAULTS[diagnosis.fault](diagnosis)}
				<p class="font-semibold">{what}</p>
				<p class="mt-1 text-mist-400">{todo}</p>
				<p class="mt-1 text-mist-400">
					The kill feed rules on the Automation tab cannot act until it is fixed.
				</p>
			{:else}
				<p class="font-semibold">The game is not posting to Warcon.</p>
				<p class="mt-1 text-mist-400">
					The kill feed rules on the Automation tab cannot act until it does. On the host, check
					that:
				</p>
				<ol class="mt-2 list-decimal space-y-1 pl-5">
					<li>
						the lines sit under <span class="chip">[{EVENT_FEED_SECTION}]</span> in
						ServerSettings.ini, with
						<span class="chip">bEventFeedEnabled=True</span>, not in a section of their own;
					</li>
					<li>
						the Url ends in <span class="font-mono text-[12.5px]">/api/ingest/events</span>: lines
						copied before 15 October 2026 named the site alone and never arrive;
					</li>
					<li>
						the server has restarted since the lines went in: the game reads them only when it
						starts;
					</li>
					<li>after Replace token, the new line took the old one's place.</li>
				</ol>
			{/if}
		</div>
	{/if}
	{#if feed?.configured && feed.token && eventFeed}
		<div class="flex items-start gap-2">
			<pre
				class="min-w-0 grow overflow-x-auto rounded-ctl border border-black bg-ink-950 px-2.5 py-1.5 font-mono text-[12.5px]">{feedLines}</pre>
			<button class="btn btn-sm" onclick={() => copyFeed(feedLines, 'Lines')}>Copy</button>
		</div>
		<p class="mt-2 text-[12.5px] text-mist-600">
			Add these lines under <span class="chip">[{EVENT_FEED_SECTION}]</span> in the server's ServerSettings.ini
			on the host, in place of any earlier EventFeedEndpoints line for this panel, then restart the server.
			RCON cannot write them: the game reads its feed endpoints from the file only.
		</p>
	{:else if feed?.configured && feed.token}
		<div class="grid grid-cols-1 gap-3 md:grid-cols-[auto_1fr]">
			<span class="text-[13px] text-mist-400 md:pt-1.5">Url</span>
			<div class="flex items-center gap-2">
				<code
					class="min-w-0 grow truncate rounded-ctl border border-black bg-ink-950 px-2.5 py-1.5 font-mono text-[12.5px]"
					>{feed.url}</code
				>
				<button class="btn btn-sm" onclick={() => copyFeed(feed!.url, 'URL')}>Copy</button>
				<span class="text-[12.5px] text-mist-600">the game adds /api/ingest/events itself</span>
			</div>
			<span class="text-[13px] text-mist-400 md:pt-1.5">Token</span>
			<div class="flex items-center gap-2">
				<code
					class="min-w-0 grow truncate rounded-ctl border border-black bg-ink-950 px-2.5 py-1.5 font-mono text-[12.5px]"
					>{feed.token}</code
				>
				<button class="btn btn-sm" onclick={() => copyFeed(feed!.token, 'Token')}>Copy</button>
			</div>
		</div>
		<div class="mt-3 flex flex-wrap items-center gap-2">
			<button class="btn btn-sm" disabled={readOnly || busy} onclick={writeFeedConfig}
				>Write to config again</button
			>
			<span class="text-[12.5px] text-mist-600"
				>the two keys are in the document below; write them again after replacing the token, or if
				the file was edited on the host</span
			>
		</div>
	{/if}
	{#if admin && eventFeed && (report || reportError || reportUnserved)}
		<!-- The game's own report: every endpoint it posts to, by scheme and host only. -->
		<div class="mt-3">
			<div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
				<span class="text-[13px] font-semibold">What the game reports</span>
				<span class="text-[12.5px] text-mist-600">
					{#if reportUnserved}this build does not report on its feed{:else if reportError}{reportError}{:else if report}{report.enabled
							? 'switched on'
							: 'switched off'} in the server's file · {report.endpointCount} endpoint{report.endpointCount ===
						1
							? ''
							: 's'} · read {fmtAgo(reportAt)}{/if}
				</span>
				{#if !reportUnserved}
					<button class="ml-auto btn btn-sm" disabled={reportBusy} onclick={readReport}
						>Read again</button
					>
				{/if}
			</div>
			{#if report?.endpoints.length}
				<div class="table-wrap">
					<table>
						<thead>
							<tr
								><th>#</th><th>Where</th><th>Healthy</th><th>Last answer</th><th class="num"
									>Failures in a row</th
								><th class="num">Sent</th><th class="num">Dropped</th><th>Last success</th></tr
							>
						</thead>
						<tbody>
							{#each report.endpoints as e, i (i)}
								<tr>
									<td class="text-mist-400">{e.index + 1}</td>
									<td class="font-mono text-[12.5px] whitespace-nowrap"
										>{e.scheme ? `${e.scheme} · ` : ''}{e.host || '—'}
										{#if feed && isPanel(e, feed.url)}<span class="chip">this panel</span>{/if}</td
									>
									<td class={e.healthy ? 'text-ok' : 'text-warn'}>{e.healthy ? 'yes' : 'no'}</td>
									<td class="font-mono text-[12.5px]">{e.lastHttpStatus ?? '—'}</td>
									<td class="num">{fmtNum(e.consecutiveFailures)}</td>
									<td class="num">{fmtNum(e.sentTotal)}</td>
									<td class="num">{fmtNum(e.droppedTotal)}</td>
									<td class="whitespace-nowrap text-mist-400"
										>{e.lastSuccessAt ? fmtAgo(e.lastSuccessAt) : 'never'}</td
									>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
	<p class="note">
		{#if eventFeed}With <span class="chip">bEventFeedEnabled</span> on and an
			<span class="chip">EventFeedEndpoints</span> entry for this panel in the server's file, the game{:else}With
			<span class="chip">[WDServerFeed]</span> set, the game{/if} posts every kill (killer, victim, weapon,
		distance, headshot) to Warcon a second or two after it happens: the kill feed on the Overview tab,
		combat stats on Analytics and player dossiers, and the team-kill trigger.
		{#if feed && !feed.configured && eventFeed}Configure creates the token and shows the lines to
			paste into the file on the host; the game reads them when it starts.{:else if feed && !feed.configured}Configure
			writes the endpoint and a token into the config document; the game reads them at its next
			restart (its scheduled one, or a manual restart).{:else if feed && !data.server.manager}An
			owner of the organisation holds the token.{/if}
	</p>
</div>

<div class="mt-4 panel">
	<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
		<span class="label-sm mb-0">Config document (ServerSettings.ini)</span>
		<span class="text-[12.5px] text-mist-400"
			>Revision <span class="font-mono">{doc?.revision || (doc ? '(none)' : '—')}</span>{#if dirty}
				· <span class="text-accent">unapplied edits</span>{/if}</span
		>
		<span class="join ml-auto">
			<button
				class="btn btn-sm {mode === 'form' ? 'btn-primary' : ''}"
				onclick={() => (mode = 'form')}>Form</button
			>
			<button
				class="btn btn-sm {mode === 'raw' ? 'btn-primary' : ''}"
				onclick={() => (mode = 'raw')}>Raw file</button
			>
		</span>
	</div>
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<div class="join">
			<button class="btn btn-sm" onclick={reload}>Reload</button>
			<button class="btn btn-sm" disabled={!dirty} onclick={discard}>Discard edits</button>
			<button
				class="btn btn-sm"
				disabled={!admin || !doc || busy}
				onclick={() => runConfig('configValidate')}>Validate</button
			>
			<button
				class="btn btn-sm btn-primary"
				disabled={readOnly || busy}
				onclick={() => runConfig('configApply')}>Apply to server</button
			>
		</div>
		<div class="join">
			<button class="btn btn-sm" disabled={!doc} onclick={copyText}>Copy</button>
			<button class="btn btn-sm" disabled={!doc} onclick={download}>Download .ini</button>
		</div>
		<label class="inline-flex items-center gap-2 text-[12.5px]"
			><input type="checkbox" bind:checked={force} /> Force (ignore revision conflict)</label
		>
	</div>
	{#if failure}
		<div class="callout mb-4 border-danger/30 bg-danger/12">
			<div>{failure}</div>
			{#each lineErrors as e, i (i)}
				<div class="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
					<span class="pip {PIP['next-restart']}"
						>{e.line !== undefined ? `line ${e.line}` : 'rejected'}</span
					>{#if e.key}<span class="font-mono">{e.key}</span>{/if}<span
						>{e.message || String(e)}</span
					>
				</div>
			{/each}
		</div>
	{/if}
	{#if mode === 'form' && doc}
		<ConfigForm
			bind:text
			serverText={doc.text}
			sections={doc.sections}
			shadowed={result?.shadowed ?? []}
			disabled={readOnly}
			tickRange={tickKnown ? { min: tickMin, max: tickMax } : null}
			liveRoutes={data.features.liveSettings}
			nameRule={data.liveName ? `/server/${encodeURIComponent(id)}/automation` : null}
		/>
		<p class="note mt-4">
			Fields edit the file one line at a time, so keys the form does not know (rotation entries, ban
			and reserved lists, the RCON block) and any comments stay exactly as they are. Switch to Raw
			file to see or edit the whole document.
		</p>
	{:else}
		<textarea
			class="min-h-[420px] input font-mono text-[12.5px] leading-relaxed pointer-coarse:text-[16px]"
			rows="26"
			spellcheck="false"
			bind:value={text}
			readonly={readOnly}></textarea>
	{/if}

	{#if docError}
		<div class="mt-3 callout mb-0">
			No config document on this server ({docError}). Older WDRCON builds only expose the live
			settings above.
		</div>
	{:else if doc && !doc.writable}
		<div class="mt-3 callout mb-0">
			This server reports its config document as read-only (no -StandaloneConfig). Edits here cannot
			be applied.
		</div>
	{/if}
	{#if pinned.length}
		<div class="mt-3 callout mb-0">
			Pinned by this server's launch arguments and shown read-only:
			<ul class="mt-1 list-disc pl-5">
				{#each pinned as k (k.section + '|' + k.key)}
					<li>
						<span class="font-mono">{k.key}</span>{#if k.lockedBy}&nbsp;(-{k.lockedBy}){/if}:
						{k.description}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
	{#each doc?.warnings ?? [] as w, i (i)}
		<div class="mt-3 callout mb-0">
			{typeof w === 'object' && w && 'message' in w
				? String((w as { message: unknown }).message)
				: String(w)}
		</div>
	{/each}
	{#if result}
		<div class="mt-3 space-y-1.5">
			{#each result.outcomes as o (o.section)}
				<div class="flex flex-wrap items-center gap-2 text-[13px]">
					<span class="pip {PIP[o.state] || PIP.pending}">{o.state}</span><span class="font-mono"
						>{o.section}</span
					>{#if o.detail}<span class="text-mist-400">{o.detail}</span>{/if}
				</div>
			{/each}
			{#each result.shadowed as s (s.section + s.key)}
				<div class="flex flex-wrap items-center gap-2 text-[13px]">
					<span class="pip {PIP.shadowed}">patch override</span><span class="font-mono"
						>{s.section} {s.key}</span
					><span class="text-mist-400">declared {s.declared}, effective {s.effective}</span>
				</div>
			{/each}
			{#each result.warnings as w, i (i)}
				<div class="flex flex-wrap items-center gap-2 text-[13px]">
					<span class="pip {PIP.pending}">warning</span><span
						>{typeof w === 'object' && w && 'message' in w
							? String((w as { message: unknown }).message)
							: String(w)}</span
					>
				</div>
			{/each}
			{#if result.timingsMs?.total !== undefined}<div class="font-mono text-[12px] text-mist-600">
					{result.timingsMs.total} ms
				</div>{/if}
		</div>
	{/if}
	<p class="note">
		Apply sends the whole file back; the server validates it as one unit and reports per section
		whether it is live now, next match, or needs a restart. Requires the server launched with
		-StandaloneConfig=&lt;path&gt;; otherwise the document is read-only here.
	</p>
</div>
