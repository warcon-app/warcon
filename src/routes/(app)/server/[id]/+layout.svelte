<script lang="ts">
	import { page } from '$app/state';
	import { health, setHealth } from '$lib/health.svelte';
	import Pulse from '$lib/components/Pulse.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const TABS = [
		['', 'Overview'],
		['/players', 'Players'],
		['/rotation', 'Map rotation'],
		['/config', 'Configuration'],
		['/automation', 'Automation'],
		['/analytics', 'Analytics'],
		['/log', 'Server log']
	] as const;
	let base = $derived(`/server/${encodeURIComponent(data.server.id)}`);
	let current = $derived(page.url.pathname.slice(base.length) || '');
	// A dossier (/players/<steamId>) keeps the Players tab lit.
	const isCurrent = (path: string) =>
		current === path || (path !== '' && current.startsWith(path + '/'));

	$effect(() => {
		setHealth(data.server.id, data.reachable);
	});
	let live = $derived(health[data.server.id]);

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

<svelte:head><title>{data.server.name} · {data.appName}</title></svelte:head>

<div class="mb-4 rise rounded-card border border-l-[3px] border-black border-l-accent bg-ink-900">
	<div class="flex flex-wrap items-center gap-3 px-5 py-4">
		<div class="min-w-0 grow">
			<h1 class="truncate text-xl font-semibold tracking-tight">{data.server.name}</h1>
			<div class="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-mist-400">
				<span class="font-mono">{data.server.host}:{data.server.port}</span>
				<RoleBadge role={data.server.role} />
				{#if data.server.demo}<Badge tone="info">demo</Badge>{/if}
				{#if data.server.notes}<span class="truncate">· {data.server.notes}</span>{/if}
			</div>
		</div>
		<span
			class="inline-flex items-center gap-2 text-[12.5px] {live === false
				? 'text-danger'
				: 'text-mist-400'}"
		>
			<Pulse ok={live} />
			{live === true ? 'live' : live === false ? 'unreachable' : 'connecting…'}
		</span>
	</div>
</div>

<nav
	bind:this={tabs}
	class="strip mb-5 gap-1 border-b border-white/8 pb-3"
	aria-label="Server sections"
>
	{#each TABS as [path, label] (path)}
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
