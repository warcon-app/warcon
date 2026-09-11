<script lang="ts">
	import { page } from '$app/state';
	import { afterNavigate, invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import Mark from '$lib/components/Mark.svelte';
	import Pulse from '$lib/components/Pulse.svelte';
	import { health } from '$lib/health.svelte';
	import { initials } from '$lib/format';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	let currentId = $derived(
		page.route.id?.includes('/server/[id]') ? (page.params.id ?? null) : null
	);
	// A server outside the org scope still opens by link: the server layout supplies it.
	let current = $derived(
		data.servers.find((s) => s.id === currentId) ??
			(currentId ? (page.data.server as (typeof data.servers)[number] | undefined) : undefined)
	);
	// Group the switcher by org once the user can see more than one.
	let multiOrg = $derived(new Set(data.servers.map((s) => s.orgId)).size > 1);
	let switcherOpen = $state(false);
	let scopeOpen = $state(false);
	let userOpen = $state(false);

	// Type-to-filter once the switcher is long enough to need it.
	let query = $state('');
	let searchable = $derived(data.servers.length > 8);
	let listed = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return data.servers;
		return data.servers.filter((s) =>
			`${s.name} ${s.host}:${s.port} ${s.orgName}`.toLowerCase().includes(needle)
		);
	});

	// The organisation scope: which org's servers the switcher, dashboard and Servers page show.
	let scopeBusy = $state(false);
	async function setScope(orgId: string | null) {
		scopeOpen = false;
		switcherOpen = false;
		if ((data.scope?.id ?? null) === orgId) return;
		scopeBusy = true;
		try {
			await api('PUT', '/api/scope', { orgId });
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			scopeBusy = false;
		}
	}

	const isActive = (path: string) =>
		path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path);
	const closeAll = () => {
		switcherOpen = false;
		scopeOpen = false;
		userOpen = false;
		query = '';
	};
	afterNavigate(closeAll);
</script>

<svelte:window onclick={closeAll} onkeydown={(e) => e.key === 'Escape' && closeAll()} />

<header class="sticky top-0 z-30 border-b border-black bg-ink-900">
	<div class="page-x flex h-[58px] items-center gap-3">
		<a
			href="/"
			class="flex shrink-0 items-center gap-2.5 font-semibold tracking-tight"
			aria-label="{data.appName} dashboard"
		>
			<Mark />
			<span
				class="font-display text-[19px] font-semibold tracking-[0.1em] uppercase {current
					? 'hidden sm:inline'
					: ''}">{data.appName}</span
			>
			<span class="hidden caps text-mist-600 sm:inline">rcon</span>
		</a>

		{#if data.orgs.length > 1}
			<!-- Phones get the same choice inside the server switcher instead. -->
			<div class="relative ml-1 hidden shrink-0 sm:block">
				<button
					type="button"
					class="btn max-w-[110px] gap-1.5 pr-2.5 sm:max-w-[200px]"
					title="Organisation scope"
					aria-haspopup="menu"
					aria-expanded={scopeOpen}
					disabled={scopeBusy}
					onclick={(e) => {
						e.stopPropagation();
						userOpen = false;
						switcherOpen = false;
						scopeOpen = !scopeOpen;
					}}
				>
					<span class="truncate {data.scope ? '' : 'text-mist-400'}"
						>{data.scope ? data.scope.name : 'All orgs'}</span
					>
					<span class="text-[10px] text-mist-600">▼</span>
				</button>
				{#if scopeOpen}
					<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
					<div class="menu" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
						<div class="px-3 pt-2 pb-1 caps text-mist-600">Show servers of</div>
						<button
							type="button"
							class="menu-item {data.scope ? '' : 'border-accent! bg-accent/10 text-accent'}"
							role="menuitemradio"
							aria-checked={!data.scope}
							onclick={() => setScope(null)}>All organisations</button
						>
						{#each data.orgs as o (o.id)}
							<button
								type="button"
								class="menu-item {data.scope?.id === o.id
									? 'border-accent! bg-accent/10 text-accent'
									: ''}"
								role="menuitemradio"
								aria-checked={data.scope?.id === o.id}
								onclick={() => setScope(o.id)}
							>
								<span class="truncate">{o.name}</span>
								{#if o.id === data.user.defaultOrgId}<span class="ml-auto text-[11px] text-mist-600"
										>default</span
									>{/if}
							</button>
						{/each}
						<div class="my-1.5 border-t border-white/8"></div>
						<a href="/account" class="menu-item text-mist-400" role="menuitem" onclick={closeAll}
							>Set a default…</a
						>
					</div>
				{/if}
			</div>
		{/if}

		<div class="relative ml-1 min-w-0 flex-1 sm:flex-none">
			<button
				type="button"
				class="btn max-w-full gap-2 pr-2.5 text-[13px] font-medium tracking-normal normal-case sm:max-w-[260px]"
				aria-haspopup="menu"
				aria-expanded={switcherOpen}
				onclick={(e) => {
					e.stopPropagation();
					userOpen = false;
					scopeOpen = false;
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
					{#if searchable}
						<div class="p-1 pb-1.5">
							<input
								class="input py-1.5 text-[13px]"
								type="search"
								placeholder="Find a server…"
								bind:value={query}
								aria-label="Find a server"
								{@attach (el) => el.focus()}
							/>
						</div>
					{/if}
					{#each listed as s, i (s.id)}
						{#if multiOrg && (i === 0 || listed[i - 1].orgId !== s.orgId)}
							<div class="px-3 pt-2 pb-1 caps text-mist-600">{s.orgName}</div>
						{/if}
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
							{#if query.trim()}
								No server matches.
							{:else if data.scope}
								No servers in {data.scope.name}.
							{:else}
								{data.canManage ? 'No servers yet.' : 'No servers shared with you yet.'}
							{/if}
						</div>
					{/each}
					{#if data.canManage}
						<div class="my-1.5 border-t border-white/8"></div>
						<a href="/servers" class="menu-item text-mist-400" role="menuitem" onclick={closeAll}
							>Manage servers…</a
						>
					{/if}
					{#if data.orgs.length > 1}
						<div class="sm:hidden">
							<div class="my-1.5 border-t border-white/8"></div>
							<div class="px-3 pt-1 pb-1 caps text-mist-600">Show servers of</div>
							<button
								type="button"
								class="menu-item {data.scope ? '' : 'border-accent! bg-accent/10 text-accent'}"
								role="menuitemradio"
								aria-checked={!data.scope}
								onclick={() => setScope(null)}>All organisations</button
							>
							{#each data.orgs as o (o.id)}
								<button
									type="button"
									class="menu-item {data.scope?.id === o.id
										? 'border-accent! bg-accent/10 text-accent'
										: ''}"
									role="menuitemradio"
									aria-checked={data.scope?.id === o.id}
									onclick={() => setScope(o.id)}><span class="truncate">{o.name}</span></button
								>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<nav class="ml-2 hidden items-center gap-1 md:flex" aria-label="Main">
			<a href="/" class="nav-pill {isActive('/') ? 'nav-pill-active' : ''}">Dashboard</a>
			<a href="/audit" class="nav-pill {isActive('/audit') ? 'nav-pill-active' : ''}">Audit</a>
			{#if data.canManage}
				<a href="/servers" class="nav-pill {isActive('/servers') ? 'nav-pill-active' : ''}"
					>Servers</a
				>
			{/if}
			<a href="/orgs" class="nav-pill {isActive('/orgs') ? 'nav-pill-active' : ''}">Orgs</a>
			{#if data.user.role === 'owner'}
				<a href="/users" class="nav-pill {isActive('/users') ? 'nav-pill-active' : ''}">Users</a>
				<a href="/settings" class="nav-pill {isActive('/settings') ? 'nav-pill-active' : ''}"
					>Settings</a
				>
			{/if}
		</nav>

		<div class="relative ml-auto shrink-0">
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
					class="menu right-0 left-auto max-sm:left-3"
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
						{#if data.canManage}
							<a href="/servers" class="menu-item" role="menuitem">Servers</a>
						{/if}
						<a href="/orgs" class="menu-item" role="menuitem">Orgs</a>
						{#if data.user.role === 'owner'}
							<a href="/users" class="menu-item" role="menuitem">Users</a>
							<a href="/settings" class="menu-item" role="menuitem">Settings</a>
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
<footer class="page-x pb-6 text-[12px] text-mist-600">
	Map imagery &copy; BULKHEAD, from the official WARDOGS RCON console. Warcon is a community tool
	and is not affiliated with BULKHEAD or Team17.
</footer>
