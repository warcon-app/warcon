<script lang="ts">
	// The server's public pages (a section of the Settings tab): a live status page and a
	// leaderboard with career pages, each open to anyone with the address once switched on here
	// (the site owner can close them for the organisation). Org owners only, like the server
	// dialog that carries the same switches.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import { featureState, FEATURE_LABELS, PUBLIC_FEATURES, type PublicFeature } from '$lib/features';
	import type { ServerInfo } from '$lib/types';

	let { data }: { data: { server: ServerInfo; origin: string } } = $props();
	let busy = $state(false);
	let orgPage = $derived(`/orgs/${encodeURIComponent(data.server.orgId)}`);

	const KEY = { status: 'publicStatus', leaderboards: 'publicLeaderboards', matches: 'publicMatches' } as const;
	const PATH = { status: '', leaderboards: '/leaderboard', matches: '/matches' } as const;
	const ABOUT: Record<PublicFeature, string> = {
		status:
			'Map, mode, scores, player count, join code and who is on with kills and deaths, refreshed every twenty seconds.',
		leaderboards:
			"The same board as the Leaderboards tab (this server, or the organisation's public servers), and a career page per player.",
		matches:
			'List of matches, can open match statiscics'
	};
	const address = (feature: PublicFeature) =>
		`${data.origin}/s/${encodeURIComponent(data.server.id)}${PATH[feature]}`;

	async function patch(body: Record<string, boolean>, done: string) {
		busy = true;
		try {
			await api('PATCH', `/api/servers/${encodeURIComponent(data.server.id)}`, body);
			toast(done, 'ok');
			await invalidateAll();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
	const setPublic = (feature: PublicFeature, on: boolean) =>
		patch({ [KEY[feature]]: on }, `${FEATURE_LABELS[feature]} is ${on ? 'on' : 'off'}.`);
	const setKills = (on: boolean) =>
		patch(
			{ publicKills: on },
			on ? 'The status page shows the kill feed.' : 'The status page no longer shows the kill feed.'
		);
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast('Address copied.', 'ok');
		} catch {
			window.prompt('Copy the address:', text);
		}
	}
</script>

<div class="panel">
	<span class="label-sm">Public pages</span>
	<p class="mb-4 text-[13px] text-mist-400">
		Pages anyone can open without a sign-in. They show in-game names, never SteamIDs, pings, cash or
		anything about the panel, and an unreachable server says only that it could not be reached. Each
		has a JSON twin under <code class="chip">/api/public/servers/{data.server.id}</code>.
	</p>
	{#if !data.server.manager}
		<p class="note">Only an owner of {data.server.orgName} can switch these on.</p>
	{:else}
		{#each PUBLIC_FEATURES as feature (feature)}
			{@const st = featureState(data.server, data.server, feature)}
			<div class="border-b border-white/[0.06] py-4 last:border-0">
				<label class="flex items-center gap-2 text-[14px] {st.allowed ? '' : 'opacity-50'}">
					<input
						type="checkbox"
						checked={st.wanted}
						disabled={busy || !st.allowed}
						onchange={(e) => setPublic(feature, e.currentTarget.checked)}
					/>
					<span class="font-medium">{FEATURE_LABELS[feature]}</span>
					{#if st.on}<Badge tone="ok">public</Badge>{:else if st.reason}<Badge tone="err"
							>closed</Badge
						>{:else}<Badge>off</Badge>{/if}
				</label>
				<p class="mt-1 pl-6 text-[13px] text-mist-400">{ABOUT[feature]}</p>
				<div class="mt-2 pl-6">
					{#if st.reason}
						<span class="text-[12.5px] text-mist-400">{st.reason}</span>
					{:else}
						<div class="join w-full sm:w-auto">
							<a
								href={address(feature)}
								target="_blank"
								rel="noopener noreferrer"
								class="flex input items-center font-mono text-[12.5px] break-all {st.on
									? ''
									: 'text-mist-600'}">{address(feature)}</a
							>
							<button type="button" class="btn btn-sm h-auto" onclick={() => copy(address(feature))}
								>Copy</button
							>
						</div>
						{#if !st.on}<p class="note">Answers 404 until switched on.</p>{/if}
					{/if}
					{#if feature === 'status' && !st.reason}
						<label class="mt-3 flex items-center gap-2 text-[13.5px]">
							<input
								type="checkbox"
								checked={data.server.publicKills}
								disabled={busy}
								onchange={(e) => setKills(e.currentTarget.checked)}
							/>
							<span>Show the kill feed on it</span>
						</label>
						<p class="mt-1 pl-6 text-[12.5px] text-mist-400">
							The last twenty kills with weapon and distance, names only. Needs the kill feed on the
							Kills tab.
						</p>
					{/if}
				</div>
			</div>
		{/each}
		<p class="note">
			A Discord status card can link to these pages: pick the links on the channel above. The
			organisation's Discord invite, shown as a button on every public page, is set on the
			<a href={orgPage} class="text-accent hover:underline">org page</a>.
		</p>
	{/if}
</div>
