<script lang="ts">
	import { page } from '$app/state';
	import { can, type Capability } from '$lib/capabilities';
	import { health, identity, setHealth, throttled } from '$lib/health.svelte';
	import Pulse from '$lib/components/Pulse.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import { toast } from '$lib/toast.svelte';
	import { fmtUptime, restartWindow, RESTART_SOON_MS } from '$lib/uptime';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// A tab whose reads need more than View names the capability; the API refuses the same people.
	const TABS: readonly (readonly [string, string, Capability?])[] = [
		['', 'Overview'],
		['/players', 'Players'],
		['/kills', 'Kills'],
		['/matches', 'Matches'],
		['/bans', 'Bans'],
		['/slots', 'Reserved slots'],
		['/rotation', 'Map rotation'],
		['/config', 'Config', 'config.apply'],
		['/automation', 'Automation', 'automation.manage'],
		['/analytics', 'Analytics'],
		['/leaderboard', 'Leaderboards'],
		['/log', 'Server log', 'audit.read']
	];
	// Discord channels and the public pages are an org owner's to manage, so Settings shows for them alone.
	let visibleTabs = $derived([
		...TABS.filter(([, , cap]) => !cap || can(data.server.caps, cap)),
		...(data.server.manager ? [['/settings', 'Settings'] as const] : [])
	]);
	let base = $derived(`/server/${encodeURIComponent(data.server.id)}`);
	let current = $derived(page.url.pathname.slice(base.length) || '');
	// A dossier (/players/<steamId>) keeps the Players tab lit.
	const isCurrent = (path: string) =>
		current === path || (path !== '' && current.startsWith(path + '/'));
	// One title for the whole section, written again on every navigation: a page that set its own
	// would leave it behind on the way out, since nothing here changes to write this one again.
	const title = () =>
		[
			(page.data.dossier as { name?: string } | undefined)?.name,
			visibleTabs.find(([path]) => path !== '' && isCurrent(path))?.[1],
			data.server.name,
			data.appName
		]
			.filter(Boolean)
			.join(' · ');

	$effect(() => {
		setHealth(data.server.id, data.reachable);
	});

	// The stream may learn the id after the page loaded; the load's answer is the fallback.
	let ident = $derived(identity[data.server.id] ?? data.identity);
	async function copyId(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast('Join code copied.', 'ok');
		} catch {
			window.prompt('Copy the join code:', text);
		}
	}
	let live = $derived(health[data.server.id]);
	// The uptime counts up on its own between looks: a minute clock, only while the page is open.
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	let restart = $derived(
		live === false ? null : restartWindow(ident.startedAt, data.server.restartSchedule, now)
	);
	let slowed = $derived(!!throttled[data.server.id]);

	// On phones the tab row scrolls sideways; keep the active tab in view after navigating.
	let tabs = $state<HTMLElement>();
	$effect(() => {
		void current;
		const active = tabs?.querySelector<HTMLElement>('.tab-link-active');
		if (!active || !tabs || tabs.scrollWidth <= tabs.clientWidth) return;
		const left = active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2;
		tabs.scrollTo({ left, behavior: 'smooth' });
	});
</script>

<svelte:head><title>{title()}</title></svelte:head>

<div class="mb-4 rise rounded-card border border-l-[3px] border-black border-l-accent bg-ink-900">
	<div class="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
		<div class="min-w-0 grow">
			<h1 class="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
				<span class="truncate">{data.server.name}</span>
				<RoleBadge role={data.server.roleName} />
				{#if data.server.demo}<Badge tone="info">demo</Badge>{/if}
			</h1>
			<div class="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-mist-400">
				{#if data.server.host}
					<span class="font-mono text-mist-200">{data.server.host}:{data.server.port}</span>
				{/if}
				{#if ident.gameServerId}
					{#if data.server.host}<span class="text-mist-600">·</span>{/if}
					<button
						type="button"
						class="group inline-flex cursor-pointer items-center gap-1.5 text-left"
						title="Click to copy"
						onclick={() => copyId(ident.gameServerId)}
					>
						<span class="font-mono break-all text-mist-200 group-hover:text-white"
							>{ident.gameServerId}</span
						>
						<svg
							class="h-3 w-3 shrink-0 text-mist-600 group-hover:text-mist-300"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<rect x="9" y="9" width="13" height="13" rx="2" />
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
						</svg>
					</button>
				{/if}
			</div>
			{#if data.server.notes}
				<p class="mt-1.5 line-clamp-2 text-[12.5px] text-mist-400">{data.server.notes}</p>
			{/if}
		</div>
		<dl
			class="flex divide-x divide-white/8 rounded-ctl border border-white/8 bg-ink-950/70 text-[13px]"
		>
			<div class="flex flex-col gap-0.5 px-3.5 py-2">
				<dt class="caps text-mist-400">Status</dt>
				<dd
					class="inline-flex items-center gap-2 whitespace-nowrap {live === false
						? 'text-danger'
						: slowed
							? 'text-warn'
							: 'text-mist-100'}"
					title={slowed
						? 'The game server asked the panel to slow down (its per-address request limit); the next look waits for the time it gave.'
						: undefined}
				>
					<Pulse ok={live} />
					{live === true
						? slowed
							? 'rate limited'
							: 'live'
						: live === false
							? 'unreachable'
							: 'connecting…'}
				</dd>
			</div>
			{#if restart}
				<div class="flex flex-col gap-0.5 px-3.5 py-2">
					<dt class="caps text-mist-400">Uptime</dt>
					<dd class="whitespace-nowrap text-mist-100">{fmtUptime(restart.upMs)}</dd>
				</div>
				{#if restart.untilDueMs !== null || restart.due}
					<div class="flex flex-col gap-0.5 px-3.5 py-2">
						<dt class="caps text-mist-400">Restart</dt>
						<dd
							class="whitespace-nowrap {restart.due ||
							(restart.untilDueMs !== null && restart.untilDueMs <= RESTART_SOON_MS)
								? 'text-warn'
								: 'text-mist-100'}"
						>
							{restart.due ? 'after this round' : `in ${fmtUptime(restart.untilDueMs ?? 0)}`}
						</dd>
					</div>
				{/if}
			{/if}
		</dl>
	</div>
</div>

<nav
	bind:this={tabs}
	class="strip mb-5 gap-1 border-b border-white/8 pb-3"
	aria-label="Server sections"
>
	{#each visibleTabs as [path, label] (path)}
		<a href="{base}{path}" class="tab-link {isCurrent(path) ? 'tab-link-active' : ''}">{label}</a>
	{/each}
</nav>

{#if data.reachable}
	{#key data.server.id}
		{@render children()}
	{/key}
{:else}
	<div class="callout border-danger/30 bg-danger/12">
		<b>Cannot reach this server.</b>
		{data.problem}
	</div>
	<p class="note">
		Check the host, port and RCON password under Servers, and that the listener is bound to a
		reachable address.
	</p>
{/if}
