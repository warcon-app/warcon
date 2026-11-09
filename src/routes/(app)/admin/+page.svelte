<script lang="ts">
	import { api, errorMessage } from '$lib/api';
	import { poll } from '$lib/poll';
	import { fmtAgo, fmtBytes, fmtCompact, fmtNum, fmtSpan } from '$lib/format';
	import { fmtRate, meanOf, perSecond } from '$lib/rates';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	type Overview = typeof data.overview;

	// svelte-ignore state_referenced_locally
	let live = $state<Overview>(data.overview);
	let prev = $state<Overview | null>(null);
	let recounting = $state(false);

	async function refresh(recount = false) {
		try {
			const next = (
				await api<{ overview: Overview }>(
					'GET',
					`/api/admin/overview${recount ? '?recount=1' : ''}`
				)
			).overview;
			prev = live;
			live = next;
		} catch (err) {
			if (recount) toast(errorMessage(err), 'err');
			/* otherwise keep the last view */
		}
	}
	$effect(() => poll(() => refresh(), 5000));
	async function recount() {
		recounting = true;
		try {
			await refresh(true);
		} finally {
			recounting = false;
		}
	}

	// Rates between the last two readings: the worker's counters on the worker's clock, the web's on its own.
	const worker = $derived(live.worker);
	const wp = $derived(live.worker?.process);
	const wpPrev = $derived(prev?.worker?.process);
	const web = $derived(live.web);
	const webPrev = $derived(prev?.web);
	const wRate = (pick: (p: NonNullable<typeof wp>) => number) =>
		wp ? perSecond(wpPrev ? pick(wpPrev) : undefined, pick(wp), wpPrev?.at, wp.at) : null;
	const webRate = (pick: (p: typeof web) => number) =>
		perSecond(webPrev ? pick(webPrev) : undefined, pick(web), webPrev?.at, web.at);

	const obsPerSec = $derived(wRate((p) => p.observations.ok + p.observations.failed));
	const obsMean = $derived(
		wp
			? meanOf(
					wpPrev?.observations.seconds,
					wp.observations.seconds,
					wpPrev ? wpPrev.observations.ok + wpPrev.observations.failed : undefined,
					wp.observations.ok + wp.observations.failed
				)
			: null
	);
	const finished = (w: NonNullable<Overview['worker']>) =>
		w.delivery.delivered + w.delivery.failed + w.delivery.skipped + w.delivery.unknown;
	const deliveriesPerMin = $derived.by(() => {
		const p = prev?.worker;
		if (!worker || !p) return null;
		const r = perSecond(finished(p), finished(worker), p.process.at, worker.process.at);
		return r === null ? null : r * 60;
	});
	const killsPerSec = $derived(webRate((p) => p.feed.kills));
	const postsPerSec = $derived(webRate((p) => p.feed.posts));
	const otherPerSec = $derived(webRate((p) => p.feed.other));
	const skippedPerSec = $derived(webRate((p) => p.feed.skipped));
	const dupesPerSec = $derived(webRate((p) => p.feed.duplicates));
	const repeatsPerSec = $derived(webRate((p) => p.feed.repeats));
	const reqPerSec = $derived(webRate((p) => p.requests.total));
	const publicPerSec = $derived(webRate((p) => p.requests.public));
	const reqMean = $derived(
		meanOf(
			webPrev?.requests.seconds,
			web.requests.seconds,
			webPrev?.requests.total,
			web.requests.total
		)
	);

	const build = (b: typeof web.build) => (b.commit ? `${b.version} (${b.commit})` : b.version);
	/** mid-deploy, or one host left on an old image */
	const buildsDiffer = $derived(!!wp && build(wp.build) !== build(web.build));

	const players = $derived(worker ? worker.players : live.fleet.players);
	const unreachable = $derived(live.fleet.servers - live.fleet.serversOk);
	const unobserved = $derived(live.fleet.servers - live.fleet.serversObserved);
	const ms = (s: number | null) => (s === null ? '…' : `${Math.round(s * 1000)} ms`);
	/** sub-minute spans to a tenth: the beat is a quarter second, the oldest pending row a few */
	const secs = (v: number) => (v < 60_000 ? `${Math.round(v / 100) / 10} s` : fmtSpan(v));
	const lag = (s: number | null) => (s === null ? '' : ` · lag ${Math.round(s * 1000)} ms`);

	const TOP_TABLES = 8;
	const shown = $derived(live.database.tables.slice(0, TOP_TABLES));
	const rest = $derived(live.database.tables.slice(TOP_TABLES).reduce((a, t) => a + t.bytes, 0));
	const share = (bytes: number) =>
		live.database.bytes ? Math.min(100, (bytes / live.database.bytes) * 100) : 0;

	const TILE =
		'min-w-0 rounded-card border border-black bg-ink-900 px-4 py-3.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]';
	const BIG =
		'mt-1.5 font-display text-[34px] leading-none font-semibold tracking-[0.04em] tabular';
	const SMALL = 'text-[18px] font-medium tracking-[0.02em] text-mist-400';
	const SUB = 'mt-1.5 text-[12px] text-mist-400';
</script>

<svelte:head><title>Overview · Admin · {data.appName}</title></svelte:head>

<div class="mb-4 flex flex-wrap items-center gap-2">
	{#if !worker}<Badge tone="err">worker unreachable</Badge>{:else if worker.owner}<Badge tone="ok"
			>worker holds the lease</Badge
		>{:else if worker.enabled}<Badge tone="warn">another process holds the lease</Badge
		>{:else}<Badge tone="err">worker not running</Badge>{/if}
	{#if worker?.behind}<Badge tone="err">{worker.behind} behind</Badge>{/if}
	{#if worker?.stuck}<Badge tone="err">{worker.stuck} stuck</Badge>{/if}
	{#if buildsDiffer}<Badge tone="warn">web and worker on different builds</Badge>{/if}
	{#if !live.metricsOn}<Badge tone="warn">metrics off: set METRICS_TOKEN</Badge>{/if}
	<span class="ml-auto text-[12px] text-mist-600"
		>Updated {fmtAgo(live.at)} · refreshes every 5 s</span
	>
</div>

<div class="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-6">
	<div class={TILE}>
		<span class="caps text-mist-400">Players online</span>
		<div class={BIG}>{fmtNum(players)}</div>
		<div class={SUB}>on {fmtNum(live.fleet.serversOk)} servers</div>
	</div>
	<div class={TILE}>
		<span class="caps text-mist-400">Servers</span>
		<div class={BIG}>
			{fmtNum(live.fleet.serversOk)}<small class={SMALL}> / {fmtNum(live.fleet.servers)}</small>
		</div>
		<div class={SUB}>
			{fmtNum(unreachable)} unreachable{#if unobserved > 0}
				· {fmtNum(unobserved)} never observed{/if}
		</div>
	</div>
	<div class={TILE}>
		<span class="caps text-mist-400">Organisations</span>
		<div class={BIG}>{fmtNum(live.fleet.orgs)}</div>
		<div class={SUB}>{fmtNum(live.fleet.orgsWeek)} joined in the last 7 days</div>
	</div>
	<div class={TILE}>
		<span class="caps text-mist-400">Users</span>
		<div class={BIG}>{fmtNum(live.fleet.users)}</div>
		<div class={SUB}>{fmtNum(live.fleet.usersWeek)} signed in this week</div>
	</div>
	<div class={TILE}>
		<span class="caps text-mist-400">Kill feed</span>
		<div class={BIG}>{fmtRate(killsPerSec, '')}<small class={SMALL}> kills/s</small></div>
		<div class={SUB}>
			{fmtRate(postsPerSec, '')} posts/s from {fmtNum(live.fleet.serversFeeding)} servers
		</div>
	</div>
	<div class={TILE}>
		<span class="caps text-mist-400">Observations</span>
		<div class={BIG}>{fmtRate(obsPerSec, '')}<small class={SMALL}> /s</small></div>
		<div class={SUB}>
			avg {ms(obsMean)} · {worker?.behind ?? '…'} behind · {worker?.stuck ?? '…'} stuck
		</div>
	</div>
</div>

<div class="mb-3 grid gap-3 lg:grid-cols-3">
	<div class="panel px-5 py-4">
		<div class="mb-1 flex items-center gap-2">
			<span class="caps text-mist-400">Worker</span>
			{#if worker?.owner}<Badge tone="ok">holds the lease</Badge>{/if}
		</div>
		{#if worker}
			<div class="kv">
				<span class="text-mist-400">Build</span><span class={buildsDiffer ? 'text-warn' : ''}
					>{build(worker.process.build)}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Tiers</span><span class="text-right"
					>{worker.tiers.watched} watched · {worker.tiers.hot} busy · {worker.tiers.idle} idle · {worker
						.tiers.offline} unreachable</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">In flight</span><span class="text-right"
					>{worker.active} / {worker.concurrency} · lanes busy {worker.lanes.busy}, queued {worker
						.lanes.queued}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Beat</span><span
					>{worker.beatAgoMs === null ? '—' : `${secs(worker.beatAgoMs)} ago`}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Deliveries</span><span class="text-right"
					>{worker.delivery.pending} pending{#if worker.delivery.oldestMs !== null}
						(oldest {secs(worker.delivery.oldestMs)}){/if} · {fmtRate(deliveriesPerMin, ' / min')} · {fmtNum(
						worker.delivery.failed
					)} failed since start</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Memory</span><span
					>{fmtBytes(worker.process.rssBytes)} resident{lag(worker.process.eventLoopLagP99)}</span
				>
			</div>
		{:else}
			<p class="note">The worker did not answer the health call.</p>
		{/if}
	</div>

	<div class="panel px-5 py-4">
		<div class="mb-1 flex items-center gap-2">
			<span class="caps text-mist-400">Kill feed</span><Badge>web process</Badge>
		</div>
		<div class="kv">
			<span class="text-mist-400">Servers feeding</span><span
				>{fmtNum(live.fleet.serversFeeding)} of {fmtNum(live.fleet.serversOk)} online</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Posts</span><span
				>{fmtRate(postsPerSec)} · {fmtRate(killsPerSec, '')} kills / s</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Joins, leaves, match states, results · states repeated</span><span
				>{fmtRate(otherPerSec)} · {fmtRate(repeatsPerSec)}</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Skipped · duplicates</span><span
				>{fmtRate(skippedPerSec)} · {fmtRate(dupesPerSec)}</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Refused (bad token)</span><span
				class={web.feed.unauthorized ? 'text-warn' : ''}
				>{fmtNum(web.feed.unauthorized)} since start</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Rejected · rate limited</span><span
				>{fmtNum(web.feed.rejected)} · {fmtNum(web.rateLimited.feed)} since start</span
			>
		</div>
	</div>

	<div class="panel px-5 py-4">
		<div class="mb-1 flex items-center gap-2">
			<span class="caps text-mist-400">Web</span><Badge>web process</Badge>
		</div>
		<div class="kv">
			<span class="text-mist-400">Build</span><span class={buildsDiffer ? 'text-warn' : ''}
				>{build(web.build)}</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Requests</span><span
				>{fmtRate(reqPerSec)} · avg {ms(reqMean)}</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Public pages</span><span
				>{fmtRate(publicPerSec)} · {fmtNum(live.fleet.serversPublic)} servers public</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Errors (5xx)</span><span
				class={web.requests.errors ? 'text-danger' : ''}
				>{fmtNum(web.requests.errors)} since start</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Rate limited</span><span
				>{fmtNum(web.rateLimited.total)} since start</span
			>
		</div>
		<div class="kv">
			<span class="text-mist-400">Memory</span><span
				>{fmtBytes(web.rssBytes)} resident{lag(web.eventLoopLagP99)}</span
			>
		</div>
	</div>
</div>

<div class="mb-3 grid gap-3 lg:grid-cols-[2fr_1fr]">
	<div class="panel px-5 py-4">
		<div class="mb-3 flex items-center gap-2">
			<span class="caps text-mist-400">Database</span><Badge class="whitespace-nowrap"
				>{fmtBytes(live.database.bytes)}</Badge
			>
			<span class="ml-auto text-[12px] text-mist-600">sizes from the catalog, rows estimated</span>
		</div>
		<div class="table-wrap">
			<table>
				<thead>
					<tr
						><th>Table</th><th class="num">Rows</th><th class="num">Size</th><th class="w-[36%]"
							>Share</th
						></tr
					>
				</thead>
				<tbody>
					{#each shown as t (t.name)}
						<tr>
							<td>{t.name}</td>
							<td class="num whitespace-nowrap">{fmtCompact(t.rows)}</td>
							<td class="num whitespace-nowrap">{fmtBytes(t.bytes)}</td>
							<td
								><div class="progress min-w-[120px]">
									<span style="width:{share(t.bytes)}%"></span>
								</div></td
							>
						</tr>
					{/each}
					{#if rest > 0}
						<tr>
							<td class="text-mist-400">everything else</td>
							<td class="num text-mist-400">—</td>
							<td class="num whitespace-nowrap text-mist-400">{fmtBytes(rest)}</td>
							<td>
								<div class="progress min-w-[120px]">
									<span class="bg-mist-600" style="width:{share(rest)}%"></span>
								</div>
							</td>
						</tr>
					{/if}
				</tbody>
			</table>
		</div>
		<p class="note">
			Samples grow by about 4,300 rows per server per day and roll up hourly; nothing is deleted. On
			TimescaleDB, samples and kills are compressed as they age.
		</p>
	</div>

	<div class="flex flex-col gap-3">
		<div class="panel px-5 py-4">
			<div class="mb-1 flex items-center gap-2">
				<span class="caps text-mist-400">Players seen</span>
				<span class="ml-auto text-[12px] text-mist-600"
					>{live.seen ? `counted ${fmtAgo(live.seen.at)}` : 'counting…'}</span
				>
				<button type="button" class="btn btn-sm" disabled={recounting} onclick={recount}
					>Recount</button
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Today</span><span
					>{live.seen ? fmtNum(live.seen.today) : '…'}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">Last 30 days</span><span
					>{live.seen ? fmtNum(live.seen.month) : '…'}</span
				>
			</div>
			<div class="kv">
				<span class="text-mist-400">All time</span><span
					>{live.seen ? fmtNum(live.seen.all) : '…'}</span
				>
			</div>
		</div>
		<div class="panel px-5 py-4">
			<span class="mb-1 block caps text-mist-400">Servers by build</span>
			{#each live.builds as b (b.build)}
				<div class="kv">
					<span class={b.build ? '' : 'text-mist-400'}>{b.build || 'not yet read'}</span><span
						>{fmtNum(b.count)}</span
					>
				</div>
			{:else}
				<p class="note">No servers yet.</p>
			{/each}
		</div>
	</div>
</div>

<div class="flex flex-wrap items-center gap-4 panel px-5 py-3.5">
	<span class="caps text-mist-400">Prometheus</span>
	<span class="text-[13px]">
		Every figure here and its history is exported at <code class="chip">/metrics</code> on the web
		and worker processes, bearer <code class="chip">METRICS_TOKEN</code>, for the Prometheus and
		Grafana you already run; the README has the scrape config and a dashboard to import.
	</span>
	{#if live.metricsOn}<Badge tone="ok">on</Badge>{:else}<Badge tone="warn">off</Badge>{/if}
</div>
