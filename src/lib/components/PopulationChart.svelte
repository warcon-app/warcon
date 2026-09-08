<script lang="ts">
	import type { PopulationPoint } from '$lib/server/analytics';

	let { points, range }: { points: PopulationPoint[]; range: string } = $props();

	const W = 900;
	const H = 220;
	const PAD = { l: 34, r: 12, t: 12, b: 26 };
	let hover = $state<number | null>(null);
	let svg = $state<SVGSVGElement>();

	let cap = $derived(
		Math.max(1, ...points.map((p) => p.cap ?? 0), ...points.map((p) => p.max ?? 0))
	);
	let t0 = $derived(points.length ? Date.parse(points[0].ts) : 0);
	let t1 = $derived(points.length ? Date.parse(points[points.length - 1].ts) : 1);
	const x = (ts: string) =>
		PAD.l + ((Date.parse(ts) - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
	const y = (v: number) => PAD.t + (1 - v / cap) * (H - PAD.t - PAD.b);

	// Break the line where the server was unreachable so gaps read as gaps, not as zero.
	let segments = $derived.by(() => {
		const segs: PopulationPoint[][] = [];
		let cur: PopulationPoint[] = [];
		for (const p of points) {
			if (p.avg === null) {
				if (cur.length) segs.push(cur);
				cur = [];
			} else cur.push(p);
		}
		if (cur.length) segs.push(cur);
		return segs;
	});
	const path = (seg: PopulationPoint[]) =>
		seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.avg!).toFixed(1)}`).join(' ');
	const area = (seg: PopulationPoint[]) =>
		`${path(seg)} L${x(seg[seg.length - 1].ts).toFixed(1)},${y(0)} L${x(seg[0].ts).toFixed(1)},${y(0)} Z`;
	let outages = $derived(points.filter((p) => p.avg === null));

	let yTicks = $derived.by(() => {
		const step = cap <= 10 ? 2 : cap <= 32 ? 8 : cap <= 64 ? 16 : 32;
		const t: number[] = [];
		for (let v = 0; v <= cap; v += step) t.push(v);
		return t;
	});
	let xTicks = $derived.by(() => {
		const n = 6;
		const t: { ts: number; label: string }[] = [];
		for (let i = 0; i <= n; i++) {
			const ts = t0 + ((t1 - t0) * i) / n;
			const d = new Date(ts);
			t.push({
				ts,
				label:
					range === '24h'
						? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
						: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
			});
		}
		return t;
	});

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
			minute: '2-digit'
		});
</script>

{#if !points.length}
	<div class="py-10 text-center text-mist-600">
		No samples yet. The poller records one every few seconds once it can reach the server.
	</div>
{:else}
	<div class="relative">
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<svg
			bind:this={svg}
			viewBox="0 0 {W} {H}"
			class="block h-auto w-full"
			role="img"
			aria-label="Players online over time"
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
					font-family="JetBrains Mono Variable, monospace">{v}</text
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
			{#each outages as p (p.ts)}
				<rect
					x={x(p.ts) - 1.5}
					y={PAD.t}
					width="3"
					height={H - PAD.t - PAD.b}
					fill="rgb(216 96 96 / 0.18)"
				/>
			{/each}
			{#each segments as seg, i (i)}
				{#if seg.length === 1}
					<!-- A lone bucket has no length to draw; show it as a marker. -->
					<circle cx={x(seg[0].ts)} cy={y(seg[0].avg!)} r="4" fill="#d4a843" />
				{:else}
					<path d={area(seg)} fill="rgb(212 168 67 / 0.14)" />
					<path
						d={path(seg)}
						fill="none"
						stroke="#d4a843"
						stroke-width="2"
						stroke-linejoin="round"
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
				{#if p.avg !== null}
					<circle
						cx={x(p.ts)}
						cy={y(p.avg)}
						r="4"
						fill="#d4a843"
						stroke="#1a1a1e"
						stroke-width="2"
					/>
				{/if}
			{/if}
		</svg>
		{#if hover !== null}
			{@const p = points[hover]}
			<div
				class="pointer-events-none absolute top-2 rounded-ctl border border-black bg-ink-800 px-2.5 py-1.5 text-[12px] shadow-pop"
				style="left:{Math.min(82, Math.max(2, (x(p.ts) / W) * 100))}%; transform:translateX(-50%)"
			>
				<div class="font-mono text-mist-400">{fmtTs(p.ts)}</div>
				{#if p.avg === null}
					<div class="text-danger">unreachable</div>
				{:else}
					<div><b>{Math.round(p.avg)}</b> avg · peak {p.max} / {p.cap ?? '?'}</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
