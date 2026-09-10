<script lang="ts">
	import { watchLive } from '$lib/live';
	import { fmtNum } from '$lib/format';
	import { setHealth } from '$lib/health.svelte';
	import Pulse from '$lib/components/Pulse.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import type { LiveView, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Summary = { ok: true; status: Status } | { ok: false; error: string };
	let summaries = $state<Record<string, Summary>>({});

	// Every observation the worker makes of these servers arrives here as it happens.
	function onLive(v: LiveView) {
		if (v.ok && v.status) summaries[v.serverId] = { ok: true, status: v.status };
		else if (v.status && !v.ok)
			summaries[v.serverId] = { ok: false, error: v.error || 'Unreachable.' };
		else summaries[v.serverId] = { ok: false, error: v.error || 'Not observed yet.' };
		setHealth(v.serverId, v.ok);
	}

	$effect(() => {
		const ids = data.servers.map((s) => s.id);
		return watchLive(ids, onLive);
	});
</script>

<svelte:head><title>Dashboard · {data.appName}</title></svelte:head>

<h1 class="mb-5 text-xl font-semibold tracking-tight">Dashboard</h1>

{#if !data.servers.length}
	<div class="callout">
		{#if data.canManage}
			No servers yet. <a href="/servers" class="font-semibold text-accent underline"
				>Add your first server</a
			>{#if data.demoAllowed}
				&nbsp;— or add one with host <code class="chip">demo</code>, port
				<code class="chip">1</code>, password <code class="chip">demo</code> to try the panel against
				the built-in mock game server.{:else}.{/if}
		{:else}
			No servers have been shared with you yet. Ask an owner of your organisation to grant you
			access{#if data.canCreateOrg}, or <a
					href="/sign-up"
					class="font-semibold text-accent underline">create your own organisation</a
				>{/if}.
		{/if}
	</div>
{:else}
	<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
		{#each data.servers as s (s.id)}
			{@const sum = summaries[s.id]}
			<a
				href="/server/{encodeURIComponent(s.id)}"
				class="block rise panel transition hover:border-white/16 hover:bg-white/[0.055]"
			>
				<div class="mb-1 flex items-center gap-2">
					<Pulse ok={sum ? sum.ok : undefined} />
					<span class="truncate font-semibold">{s.name}</span>
					<span class="ml-auto"><RoleBadge role={s.role} /></span>
				</div>
				<div class="mb-3 font-mono text-[12px] text-mist-400">
					{s.host}:{s.port}{#if s.demo}&nbsp;· demo{/if}
				</div>
				{#if !sum}
					<div class="text-[13px] text-mist-600">Checking…</div>
				{:else if sum.ok}
					{@const st = sum.status}
					{@const pct = st.maxPlayers
						? Math.min(100, Math.round((st.playerCount / st.maxPlayers) * 100))
						: 0}
					<div class="mb-1 truncate text-[13px] text-mist-400">{st.serverName || '—'}</div>
					<div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
						<span class="text-mist-400">Map <b class="text-mist-100">{st.map || '—'}</b></span>
						{#if st.matchSeconds !== null}<span class="text-mist-400"
								>Match <b class="text-mist-100">{Math.floor(st.matchSeconds / 60)} min</b></span
							>{/if}
						<span class="ml-auto text-mist-400"
							><b class="text-mist-100">{fmtNum(st.playerCount)}</b> / {fmtNum(st.maxPlayers)} players</span
						>
					</div>
					<div class="mb-3 progress"><span class="progress-bar" style="width:{pct}%"></span></div>
					<div class="flex flex-wrap gap-1.5">
						{#each st.scores as f (f.name)}
							<span class="badge bg-white/5" style="color:{f.colorHex || 'inherit'}"
								>{f.name} {fmtNum(f.score)}</span
							>
						{/each}
					</div>
				{:else}
					<div class="text-[13px] text-danger">{sum.error}</div>
				{/if}
			</a>
		{/each}
	</div>
{/if}
