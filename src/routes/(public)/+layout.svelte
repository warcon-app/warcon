<script lang="ts">
	// The bare public shell: the mark, the server name, the organisation, a Discord invite when
	// the org set one, links between the server's public pages, and one footer line back to the
	// panel. The same width as the panel's pages; one column on a phone, where the link is usually
	// opened from Discord.
	import { page } from '$app/state';
	import Mark from '$lib/components/Mark.svelte';
	import DiscordMark from '$lib/components/DiscordMark.svelte';
	import type { FeatureSet } from '$lib/features';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	type Heading = {
		id: string;
		name: string;
		orgName: string;
		discordInviteUrl: string;
		features: FeatureSet;
	};
	let heading = $derived((page.data.heading as Heading | undefined) ?? null);
	let base = $derived(heading ? `/s/${encodeURIComponent(heading.id)}` : '');
	let path = $derived(page.url.pathname);
	const active = (href: string, exact: boolean) =>
		exact ? path === href : path === href || path.startsWith(href + '/');
</script>

<div class="page-x flex min-h-screen flex-col pt-4 pb-6">
	<header class="mb-4 flex flex-wrap items-center gap-3">
		<a href={base || '/'} class="shrink-0" aria-label={data.appName}><Mark size={34} /></a>
		<div class="min-w-0 flex-1">
			<div
				class="truncate font-display text-[20px] leading-tight font-semibold tracking-[0.06em] uppercase"
			>
				{heading?.name ?? data.appName}
			</div>
			{#if heading?.orgName}<div class="truncate caps text-mist-400">{heading.orgName}</div>{/if}
		</div>
		{#if heading?.discordInviteUrl}
			<a
				href={heading.discordInviteUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="btn shrink-0 gap-2"><DiscordMark /> Join the Discord</a
			>
		{/if}
	</header>
	{#if heading && (heading.features.status || heading.features.leaderboards || heading.features.matches)}
		<nav class="strip mb-4 gap-1 border-b border-white/8 pb-3" aria-label="Public pages">
			{#if heading.features.status}
				<a href={base} class="tab-link {active(base, true) ? 'tab-link-active' : ''}">Live</a>
			{/if}
			{#if heading.features.leaderboards}
				<a
					href="{base}/leaderboard"
					class="tab-link {active(`${base}/leaderboard`, false) || active(`${base}/players`, false)
						? 'tab-link-active'
						: ''}">Leaderboard</a>
			{/if}
			{#if heading.features.matches}
				<a
					href="{base}/matches"
					class="tab-link {active(`${base}/matches`, false) ? 'tab-link-active' : ''}">Matches</a
				>
			{/if}
		</nav>
	{/if}
	<main class="flex-1">{@render children()}</main>
	<footer class="mt-8 border-t border-white/8 pt-4 text-[12px] leading-relaxed text-mist-600">
		Powered by <a href="/sign-in" class="font-semibold text-accent hover:underline"
			>{data.appName}</a
		>. Map imagery &copy; BULKHEAD, from the official WARDOGS RCON console; not affiliated with
		BULKHEAD or Team17.
	</footer>
</div>
