<script lang="ts">
	// Cash in play over time: one line for the total and one per faction. Fed either by the
	// dashboard (a point every few seconds for the current match) or by analytics (bucketed).
	import type { CashPoint } from '$lib/server/analytics';
	import { fmtCash, fmtCashShort } from '$lib/cash';

	let {
		points,
		color,
		label = (name: string) => name || 'Unassigned',
		range = 'live',
		view = 'chart',
		emptyText = 'No cash samples yet.'
	}: {
		points: CashPoint[];
		/** faction name -> line colour; '' is the unassigned bucket */
		color: (name: string) => string;
		label?: (name: string) => string;
		/** 'live' formats the x axis as clock time; '24h', '7d', '30d' as in the analytics page */
		range?: string;
		view?: 'chart' | 'table';
		emptyText?: string;
	} = $props();

	const TOTAL = ' total';
	const TOTAL_COLOR = '#d4a843';
	const HIDDEN_KEY = 'warcon.cashHidden';

	let width = $state(0);
	let W = $derived(Math.max(320, width || 900));
	const H = 220;
	const PAD = { l: 48, r: 12, t: 12, b: 26 };
	let hover = $state<number | null>(null);
	let svg = $state<SVGSVGElement>();
	let hidden = $state<Set<string>>(loadHidden());

	function loadHidden(): Set<string> {
		try {
			const parsed = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
			return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
		} catch {
			return new Set();
		}
	}
	function toggle(key: string) {
		const next = new Set(hidden);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		hidden = next;
		try {
			localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
		} catch {
			/* private mode */
		}
	}

	/**
	 * Faction names in first-seen order, total first. The unassigned bucket comes last and only
	 * when someone without a faction actually held cash at some point.
	 */
	let series = $derived.by(() => {
		const seen = new Set<string>();
		let unassigned = false;
		for (const p of points)
			for (const [k, v] of Object.entries(p.factions)) {
				if (k === '') unassigned ||= v > 0;
				else seen.add(k);
			}
		return [TOTAL, ...seen, ...(unassigned ? [''] : [])];
	});
	const value = (p: CashPoint, key: string): number | null =>
		key === TOTAL ? p.total : p.total === null ? null : (p.factions[key] ?? 0);
	const paint = (key: string) => (key === TOTAL ? TOTAL_COLOR : color(key));
	const name = (key: string) => (key === TOTAL ? 'Total' : label(key));
	let shown = $derived(series.filter((k) => !hidden.has(k)));

	let top = $derived.by(() => {
		let max = 0;
		for (const p of points) for (const k of shown) max = Math.max(max, value(p, k) ?? 0);
		if (max <= 0) return 1000;
		// Round up to a tidy axis: 1, 2, 2.5, 5 x 10^n.
		const mag = Math.pow(10, Math.floor(Math.log10(max)));
		const unit = max / mag;
		const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
		return nice * mag;
	});
	let t0 = $derived(points.length ? Date.parse(points[0].ts) : 0);
	let t1 = $derived(points.length ? Date.parse(points[points.length - 1].ts) : 1);
	const x = (ts: string) =>
		PAD.l + ((Date.parse(ts) - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
	const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);

	function path(key: string): string {
		let d = '';
		let pen = false;
		for (const p of points) {
			const v = value(p, key);
			if (v === null) {
				pen = false;
				continue;
			}
			d += `${pen ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(v).toFixed(1)} `;
			pen = true;
		}
		return d;
	}
	let yTicks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => f * top));
	let xTicks = $derived.by(() => {
		const n = 6;
		const t: { ts: number; label: string }[] = [];
		if (!points.length) return t;
		for (let i = 0; i <= n; i++) {
			const ts = t0 + ((t1 - t0) * i) / n;
			const d = new Date(ts);
			t.push({
				ts,
				label:
					range === 'live' || range === '24h'
						? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
						: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
			});
		}
		return t;
	});
	let latest = $derived(points.length ? points[points.length - 1] : null);

	function onmove(e: MouseEvent) {
		if (!svg || !points.length) return;
		const rect = svg.getBoundingClientRect();
		const px = ((e.clientX - rect.left) / rect.width) * W;
		let best = 0;
		let bestD = Infinity;
		points.forEach((p, i) => {
			const d = Math.abs(x(p.ts) - px);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		});
		hover = best;
	}
	const fmtTs = (ts: string) =>
		new Date(ts).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: range === 'live' ? '2-digit' : undefined
		});
	let tableRows = $derived([...points].reverse().slice(0, 300));
</script>

<div class="mb-2 flex flex-wrap gap-1.5">
	{#each series as key (key)}
		<button
			type="button"
			class="btn inline-flex btn-sm items-center gap-1.5 {hidden.has(key) ? 'opacity-45' : ''}"
			aria-pressed={!hidden.has(key)}
			title={hidden.has(key) ? 'Show this series' : 'Hide this series'}
			onclick={() => toggle(key)}
		>
			<span class="inline-block h-2.5 w-2.5 rounded-full" style="background:{paint(key)}"></span>
			<span>{name(key)}</span>
			{#if latest}<span class="font-mono text-mist-400 tabular">{fmtCash(value(latest, key))}</span
				>{/if}
		</button>
	{/each}
</div>

{#if !points.length}
	<div class="py-10 text-center text-mist-600">{emptyText}</div>
{:else if view === 'table'}
	<div class="max-h-[360px] table-wrap">
		<table>
			<thead
				><tr
					><th>Time</th>{#each series as key (key)}<th class="num">{name(key)}</th>{/each}</tr
				></thead
			>
			<tbody>
				{#each tableRows as p (p.ts)}
					<tr
						><td class="font-mono text-[12px]">{fmtTs(p.ts)}</td>{#each series as key (key)}<td
								class="num">{fmtCash(value(p, key))}</td
							>{/each}</tr
					>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<div class="relative" bind:clientWidth={width}>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<svg
			bind:this={svg}
			viewBox="0 0 {W} {H}"
			class="block h-auto w-full"
			role="img"
			aria-label="Cash in play over time"
			onmousemove={onmove}
			onmouseleave={() => (hover = null)}
		>
			{#each yTicks as v (v)}
				<line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="rgb(255 255 255 / 0.07)" />
				<text
					x={PAD.l - 6}
					y={y(v) + 3.5}
					text-anchor="end"
					font-size="10"
					fill="#8a8a90"
					font-family="JetBrains Mono Variable, monospace">{fmtCashShort(v)}</text
				>
			{/each}
			{#each xTicks as t, i (i)}
				<text
					x={x(new Date(t.ts).toISOString())}
					y={H - 8}
					text-anchor="middle"
					font-size="10"
					fill="#8a8a90"
					font-family="Barlow, sans-serif">{t.label}</text
				>
			{/each}
			{#each shown as key (key)}
				{#if points.length === 1}
					{@const v = value(points[0], key)}
					{#if v !== null}<circle cx={x(points[0].ts)} cy={y(v)} r="4" fill={paint(key)} />{/if}
				{:else}
					<path
						d={path(key)}
						fill="none"
						stroke={paint(key)}
						stroke-width={key === TOTAL ? 2 : 1.5}
						stroke-linejoin="round"
						opacity={key === TOTAL ? 1 : 0.9}
					/>
				{/if}
			{/each}
			{#if hover !== null}
				{@const p = points[hover]}
				<line
					x1={x(p.ts)}
					x2={x(p.ts)}
					y1={PAD.t}
					y2={H - PAD.b}
					stroke="#e8e8e8"
					stroke-width="1"
					stroke-dasharray="3 3"
				/>
				{#each shown as key (key)}
					{@const v = value(p, key)}
					{#if v !== null}
						<circle
							cx={x(p.ts)}
							cy={y(v)}
							r="3.5"
							fill={paint(key)}
							stroke="#1a1a1e"
							stroke-width="2"
						/>
					{/if}
				{/each}
			{/if}
		</svg>
		{#if hover !== null}
			{@const p = points[hover]}
			<div
				class="pointer-events-none absolute top-2 rounded-ctl border border-black bg-ink-800 px-2.5 py-1.5 text-[12px] shadow-pop"
				style="left:{Math.min(82, Math.max(6, (x(p.ts) / W) * 100))}%; transform:translateX(-50%)"
			>
				<div class="font-mono text-mist-400">{fmtTs(p.ts)}</div>
				{#each shown as key (key)}
					<div class="flex items-center gap-1.5">
						<span class="inline-block h-2 w-2 rounded-full" style="background:{paint(key)}"
						></span><span>{name(key)}</span><span class="ml-auto pl-3 font-mono tabular"
							>{fmtCash(value(p, key))}</span
						>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
