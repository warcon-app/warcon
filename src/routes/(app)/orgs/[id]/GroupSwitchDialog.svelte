<script lang="ts">
	// When a reserved-slot group is on: off, on until switched off, for some hours, until a time,
	// or a window ahead. Each starts a new window in place of the one the group had.
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { describeSync, groupState, localInput, whenShort } from '$lib/lists';
	import Modal from '$lib/components/Modal.svelte';
	import type { ListSyncSummary, SlotGroupView } from '$lib/types';

	let { orgId, group, onclose }: { orgId: string; group: SlotGroupView; onclose: () => void } =
		$props();

	const HOURS = [
		[2, '2 hours'],
		[4, '4 hours'],
		[8, '8 hours'],
		[24, '1 day'],
		[72, '3 days'],
		[168, '7 days']
	] as const;

	type Choice = 'off' | 'forever' | 'for' | 'until' | 'later';
	const start = untrack(() => groupState(group));
	let choice = $state<Choice>(
		start.kind === 'later'
			? 'later'
			: start.kind === 'on' && untrack(() => group.onUntil)
				? 'until'
				: 'forever'
	);
	let hours = $state(4);
	let until = $state(untrack(() => (start.kind === 'on' ? localInput(group.onUntil) : '')));
	let from = $state(untrack(() => (start.kind === 'later' ? localInput(group.onFrom) : '')));
	let laterUntil = $state(untrack(() => (start.kind === 'later' ? localInput(group.onUntil) : '')));
	let busy = $state(false);

	let forEnds = $derived(new Date(Date.now() + hours * 3600_000).toISOString());

	function body(): Record<string, unknown> {
		const iso = (v: string) => new Date(v).toISOString();
		switch (choice) {
			case 'off':
				return { on: false };
			case 'forever':
				return { on: true, until: null };
			case 'for':
				return { on: true, until: new Date(Date.now() + hours * 3600_000).toISOString() };
			case 'until':
				return { on: true, until: iso(until) };
			case 'later':
				return { on: true, from: iso(from), until: iso(laterUntil) };
		}
	}

	async function save() {
		busy = true;
		try {
			const res = await api<{ group: SlotGroupView; sync: ListSyncSummary }>(
				'PUT',
				`/api/orgs/${encodeURIComponent(orgId)}/slot-groups/${encodeURIComponent(group.id)}/switch`,
				body()
			);
			const now = groupState(res.group).text;
			toast(
				res.sync.servers.length
					? describeSync(res.sync, `${group.name}: ${now}.`)
					: `${group.name}: ${now}.`,
				'ok',
				8000
			);
			await invalidateAll();
			onclose();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}

	let where = $derived(group.servers.map((s) => s.name).join(', ') || 'no servers');
</script>

<Modal label="When is {group.name} on?" {onclose}>
	<span class="label-sm mb-1!">{group.name} · {group.everyServer ? 'every server' : where}</span>
	<h3 class="mb-3 font-display text-[22px] font-semibold">When is it on?</h3>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<fieldset class="flex flex-col">
			<legend class="sr-only">When the group is on</legend>
			<label class="flex items-start gap-2.5 border-b border-white/6 py-2.5">
				<input type="radio" class="mt-1" value="off" bind:group={choice} />
				<span
					><b>Off</b><span class="block text-[12.5px] text-mist-400"
						>Its players lose the slot on its servers. Live servers keep it until their next
						restart.</span
					></span
				>
			</label>
			<label class="flex items-start gap-2.5 border-b border-white/6 py-2.5">
				<input type="radio" class="mt-1" value="forever" bind:group={choice} />
				<b>On until I switch it off</b>
			</label>
			<label class="flex flex-wrap items-center gap-2.5 border-b border-white/6 py-2.5">
				<input type="radio" value="for" bind:group={choice} />
				<b>On for</b>
				<select
					class="input w-32!"
					aria-label="How long"
					bind:value={hours}
					onfocus={() => (choice = 'for')}
				>
					{#each HOURS as [h, label] (h)}<option value={h}>{label}</option>{/each}
				</select>
				<span class="text-[12.5px] text-mist-400">until {whenShort(forEnds)}</span>
			</label>
			<label class="flex flex-wrap items-center gap-2.5 border-b border-white/6 py-2.5">
				<input type="radio" value="until" bind:group={choice} />
				<b>On until</b>
				<input
					class="input w-56!"
					type="datetime-local"
					aria-label="Until"
					bind:value={until}
					onfocus={() => (choice = 'until')}
					required={choice === 'until'}
				/>
			</label>
			<div class="flex items-start gap-2.5 py-2.5">
				<input
					type="radio"
					id="when-later"
					class="mt-1"
					value="later"
					bind:group={choice}
					aria-label="On later"
				/>
				<div class="flex flex-1 flex-col gap-2">
					<label for="when-later"><b>On later</b></label>
					<div class="flex flex-wrap gap-2">
						<label class="min-w-44 flex-1"
							><span class="field-label">From</span><input
								class="input"
								type="datetime-local"
								bind:value={from}
								onfocus={() => (choice = 'later')}
								required={choice === 'later'}
							/></label
						>
						<label class="min-w-44 flex-1"
							><span class="field-label">Until</span><input
								class="input"
								type="datetime-local"
								bind:value={laterUntil}
								onfocus={() => (choice = 'later')}
								required={choice === 'later'}
							/></label
						>
					</div>
				</div>
			</div>
		</fieldset>
		<p class="note">
			Times are your local time, up to a year ahead. A window opens and closes by itself within a
			minute. Saving replaces the window the group had.
		</p>
		<div class="mt-5 flex flex-wrap justify-end gap-2">
			<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy}>Save</button>
		</div>
	</form>
</Modal>
