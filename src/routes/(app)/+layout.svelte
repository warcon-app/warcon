<script lang="ts">
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import Mark from '$lib/components/Mark.svelte';
	import Pulse from '$lib/components/Pulse.svelte';
	import { health } from '$lib/health.svelte';
	import { initials } from '$lib/format';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	let currentId = $derived(
		page.route.id?.includes('/server/[id]') ? (page.params.id ?? null) : null
	);
	let current = $derived(data.servers.find((s) => s.id === currentId));
	let switcherOpen = $state(false);
	let userOpen = $state(false);

	const isActive = (path: string) =>
		path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path);
	const closeAll = () => {
		switcherOpen = false;
		userOpen = false;
	};
	afterNavigate(closeAll);
</script>

<svelte:window onclick={closeAll} onkeydown={(e) => e.key === 'Escape' && closeAll()} />

<header class="sticky top-0 z-30 border-b border-black bg-ink-900">
	<div class="page-x flex h-[58px] items-center gap-3">
		<a href="/" class="flex items-center gap-2.5 font-semibold tracking-tight">
			<Mark />
			<span class="font-display text-[19px] font-semibold tracking-[0.1em] uppercase"
				>{data.appName}</span
			>
			<span class="hidden caps text-mist-600 sm:inline">rcon</span>
		</a>

		<div class="relative ml-1">
			<button
				type="button"
				class="btn max-w-[260px] gap-2 pr-2.5 text-[13px] font-medium tracking-normal normal-case"
				aria-haspopup="menu"
				aria-expanded={switcherOpen}
				onclick={(e) => {
					e.stopPropagation();
					userOpen = false;
					switcherOpen = !switcherOpen;
				}}
			>
				<Pulse ok={current ? health[current.id] : undefined} />
				<span class="truncate">{current ? current.name : 'Select a server'}</span>
				<span class="text-[10px] text-mist-600">▼</span>
			</button>
			{#if switcherOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<div class="menu" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
					{#each data.servers as s (s.id)}
						<a
							href="/server/{encodeURIComponent(s.id)}"
							class="menu-item {s.id === currentId
								? 'border-accent! bg-accent/10 text-accent'
								: ''}"
							role="menuitem"
							onclick={closeAll}
						>
							<Pulse ok={health[s.id]} />
							<span class="truncate">{s.name}</span>
							<span class="ml-auto text-[11px] text-mist-600">{s.role}</span>
						</a>
					{:else}
						<div class="px-3 py-2 text-[12.5px] text-mist-400">
							{data.user.role === 'owner' ? 'No servers yet.' : 'No servers shared with you yet.'}
						</div>
					{/each}
					{#if data.user.role === 'owner'}
						<div class="my-1.5 border-t border-white/8"></div>
						<a href="/servers" class="menu-item text-mist-400" role="menuitem" onclick={closeAll}
							>Manage servers…</a
						>
					{/if}
				</div>
			{/if}
		</div>

		<nav class="ml-2 hidden items-center gap-1 md:flex" aria-label="Main">
			<a href="/" class="nav-pill {isActive('/') ? 'nav-pill-active' : ''}">Dashboard</a>
			<a href="/audit" class="nav-pill {isActive('/audit') ? 'nav-pill-active' : ''}">Audit</a>
			{#if data.user.role === 'owner'}
				<a href="/users" class="nav-pill {isActive('/users') ? 'nav-pill-active' : ''}">Users</a>
				<a href="/servers" class="nav-pill {isActive('/servers') ? 'nav-pill-active' : ''}"
					>Servers</a
				>
			{/if}
		</nav>

		<div class="relative ml-auto">
			<button
				type="button"
				class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-ctl border border-black bg-accent text-[12px] font-bold text-ink-950"
				title="@{data.user.username}"
				aria-haspopup="menu"
				aria-expanded={userOpen}
				onclick={(e) => {
					e.stopPropagation();
					switcherOpen = false;
					userOpen = !userOpen;
				}}
			>
				{#if data.user.image}
					<img
						src={data.user.image}
						alt=""
						class="h-full w-full object-cover"
						referrerpolicy="no-referrer"
					/>
				{:else}
					{initials(data.user.name || data.user.username)}
				{/if}
			</button>
			{#if userOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<div
					class="menu right-0 left-auto"
					role="menu"
					tabindex="-1"
					onclick={(e) => e.stopPropagation()}
				>
					<div class="px-3 py-2">
						<div class="font-semibold">{data.user.name || data.user.username}</div>
						<div class="font-mono text-[12px] text-mist-400">
							@{data.user.username} · {data.user.role}
						</div>
					</div>
					<div class="my-1.5 border-t border-white/8"></div>
					<nav class="md:hidden" aria-label="Main (mobile)">
						<a href="/" class="menu-item" role="menuitem">Dashboard</a>
						<a href="/audit" class="menu-item" role="menuitem">Audit</a>
						{#if data.user.role === 'owner'}
							<a href="/users" class="menu-item" role="menuitem">Users</a>
							<a href="/servers" class="menu-item" role="menuitem">Servers</a>
						{/if}
						<div class="my-1.5 border-t border-white/8"></div>
					</nav>
					<a href="/account" class="menu-item" role="menuitem">Account &amp; sessions</a>
					<form method="post" action="/sign-out">
						<button type="submit" class="menu-item text-mist-400" role="menuitem">Sign out</button>
					</form>
				</div>
			{/if}
		</div>
	</div>
</header>

<main class="page-x py-6">
	{@render children()}
</main>
