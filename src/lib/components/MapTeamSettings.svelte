<script lang="ts">
	import { api, errorMessage } from '$lib/api';
	import { mapTeamKey, type MapTeamMode } from '$lib/map-team-mode';
	import { toast } from '$lib/toast.svelte';
	import type { MapSelection, TriggerView } from '$lib/types';
	const t = (message: string) => message;
	let {
		serverId,
		selection,
		disabled = false,
		teamVersusTeam = $bindable(false)
	}: {
		serverId: string;
		selection: MapSelection;
		disabled?: boolean;
		teamVersusTeam?: boolean;
	} = $props();
	let rules = $state<TriggerView[]>([]);
	let loaded = $state('');
	let error = $state('');
	let busy = $state(false);
	let random = $state(false);
	let mode = $derived<MapTeamMode['mode']>(
		teamVersusTeam ? (random ? 'random' : 'manual') : 'standard'
	);
	let closedFaction = $state('Lonestar');
	let rule = $derived(rules.find((r) => r.kind === 'two_teams'));
	let saved = $derived(
		(rule?.config.mapOverrides as MapTeamMode[] | undefined)?.find(
			(o) => mapTeamKey(o.selection) === mapTeamKey(selection)
		)
	);
	$effect(() => {
		teamVersusTeam = saved?.mode === 'manual' || saved?.mode === 'random';
		random = saved?.mode === 'random';
		closedFaction = saved?.closedFaction ?? 'Lonestar';
	});
	$effect(() => {
		const target = serverId;
		let stopped = false;
		loaded = '';
		error = '';
		api<{ triggers: TriggerView[] }>('GET', `/api/servers/${encodeURIComponent(target)}/triggers`)
			.then((r) => {
				if (!stopped) {
					rules = r.triggers;
					loaded = target;
				}
			})
			.catch((e) => {
				if (!stopped) error = errorMessage(e);
			});
		return () => {
			stopped = true;
		};
	});
	let changed = $derived(
		teamVersusTeam
			? mode !== saved?.mode || (mode === 'manual' && closedFaction !== saved?.closedFaction)
			: saved?.mode === 'manual' || saved?.mode === 'random'
	);
	export function ready() {
		return loaded === serverId && !busy && !error;
	}
	export async function save(): Promise<boolean> {
		if (!ready()) return false;
		if (!changed) return true;
		const target = serverId;
		const chosen = structuredClone($state.snapshot(selection));
		const key = mapTeamKey(chosen);
		const pickedMode = mode,
			pickedFaction = closedFaction;
		busy = true;
		try {
			const path = `/api/servers/${encodeURIComponent(target)}/triggers`;
			const fresh = await api<{ triggers: TriggerView[] }>('GET', path);
			const current = fresh.triggers.find((r) => r.kind === 'two_teams');
			const overrides = ((current?.config.mapOverrides as MapTeamMode[] | undefined) ?? []).filter(
				(o) => mapTeamKey(o.selection) !== key
			);
			overrides.push({
				selection: chosen,
				mode: pickedMode,
				...(pickedMode === 'manual' ? { closedFaction: pickedFaction } : {})
			});
			if (!current && !overrides.length) return true;
			// A disabled server-wide rule must not become active on other maps when saving this map.
			const base = current?.config ?? { closedFaction: '', balance: false, message: '' };
			const mapOnly = current ? !current.enabled || base.mapOnly === true : true;
			const config = { ...base, mapOnly, mapOverrides: overrides };
			const hasGlobal =
				!mapOnly && !!(base.closedFaction || base.randomClosedFaction || base.balance);
			const body = {
				kind: 'two_teams',
				name: current?.name ?? 'Team balance',
				enabled: hasGlobal || overrides.length > 0,
				config
			};
			await api(
				current ? 'PATCH' : 'POST',
				current ? `${path}/${encodeURIComponent(current.id)}` : path,
				body
			);
			const updated = await api<{ triggers: TriggerView[] }>('GET', path);
			if (serverId === target) rules = updated.triggers;
			return true;
		} catch (e) {
			toast(errorMessage(e), 'err');
			return false;
		} finally {
			busy = false;
		}
	}
</script>

<div class="mt-4 border-t border-white/10 pt-4">
 <label class="flex items-center gap-2"><input type="checkbox" bind:checked={teamVersusTeam} disabled={disabled || busy || loaded !== serverId} /> Use two-team balance for this map</label>
 <p class="note">This is a separate automation rule, not a native game mode. Save it separately from the rotation; players on the excluded faction will be moved.</p>
{#if teamVersusTeam || changed}
	<fieldset
		class="mt-3 border-t border-white/10 pt-3"
		disabled={disabled || busy || loaded !== serverId}
	>
		<div class="flex flex-wrap items-end gap-2">
			{#if teamVersusTeam}
				<label class="block w-full min-w-0 sm:w-56">
					<span class="label-sm mb-1.5">{t('Excluded faction')}</span>
					<select
						class="input"
						value={random ? '' : closedFaction}
						onchange={(e) => {
							closedFaction = e.currentTarget.value;
							random = false;
						}}
					>
						<option value="" disabled>{t('Random each match')}</option>
						{#each ['Lonestar', 'Valkyra', 'Manticore'] as faction}<option value={faction}
								>{faction}</option
							>{/each}
					</select>
				</label>
				<button
					type="button"
					class="btn"
					class:btn-primary={random}
					aria-pressed={random}
					onclick={() => (random = !random)}>{t('Random')}</button
				>
			{/if}
		</div>
		<p class="mt-2 text-[12px] leading-relaxed text-mist-400">
			{t(
				teamVersusTeam
					? random
						? 'Random excluded faction each match'
						: 'Players on the excluded faction move to the other two teams.'
					: 'All factions will be restored when this map selection is applied.'
			)}
		</p>
	</fieldset>
{/if}
{#if error}<p class="mt-2 text-danger">{error}</p>{/if}
 <button type="button" class="btn mt-3" disabled={disabled || busy || loaded !== serverId || !changed} onclick={save}>Save map team settings</button>
</div>
