<script lang="ts">
	import Modal from './Modal.svelte';
	import { ONE_PER_SERVER, RULE_GROUPS, RULE_KINDS } from '$lib/rule-kinds';
	import type { TriggerKind, TriggerView } from '$lib/types';

	// Add rule's first step: every kind of rule as a card, in the groups of $lib/rule-kinds, with a
	// search over the names and blurbs. A kind a server holds one rule of, already here, opens that rule.
	let {
		rules,
		lacks,
		onpick,
		onclose
	}: {
		/** the server's rules: a count on each card, and the rule a one-per-server kind opens */
		rules: TriggerView[];
		/** what a kind lacks to run here, in a few words, or '' when it can */
		lacks: (kind: TriggerKind) => string;
		/** a kind to set up, or the rule of it the server already has */
		onpick: (kind: TriggerKind, rule?: TriggerView) => void;
		onclose: () => void;
	} = $props();

	let query = $state('');
	let shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return RULE_GROUPS.map((group) => ({
			group,
			kinds: RULE_KINDS.filter(
				(k) => k.group === group && (!q || `${k.label} ${k.blurb}`.toLowerCase().includes(q))
			)
		})).filter((g) => g.kinds.length);
	});
</script>

<Modal label="Add a rule" wide="xl" {onclose}>
	<div class="flex flex-wrap items-center gap-3">
		<div class="min-w-0 grow">
			<h3 class="text-[15px] font-semibold">Add a rule</h3>
			<p class="mt-0.5 text-[12.5px] text-mist-400">Pick what it does; you set it up next.</p>
		</div>
		<input
			class="order-last input w-full sm:order-none sm:w-[300px]"
			type="search"
			placeholder="Find a rule: kick, whisper, slot, map…"
			aria-label="Find a rule"
			bind:value={query}
		/>
		<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
	</div>

	{#each shown as g (g.group)}
		<section class="mt-4">
			<h4 class="mb-2 caps text-mist-600">{g.group}</h4>
			<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{#each g.kinds as k (k.kind)}
					{@const here = rules.filter((r) => r.kind === k.kind)}
					{@const only = ONE_PER_SERVER.includes(k.kind) ? here[0] : undefined}
					{@const why = only ? '' : lacks(k.kind)}
					<button
						type="button"
						class="flex cursor-pointer flex-col items-start gap-0.5 rounded-ctl border border-black bg-ink-950 px-3.5 py-2.5 text-left transition hover:border-accent/60 hover:bg-ink-800 focus-visible:border-accent focus-visible:outline-none"
						onclick={() => onpick(k.kind, only)}
					>
						<span class="text-[13.5px] font-semibold {why ? 'text-mist-400' : 'text-mist-100'}"
							>{k.label}</span
						>
						<span class="text-[12.5px] leading-snug {why ? 'text-mist-600' : 'text-mist-400'}"
							>{k.blurb}</span
						>
						{#if only}
							<span class="mt-1 text-[11.5px] text-mist-100"
								>One per server: opens “{only.name}”</span
							>
						{:else if why}
							<span class="mt-1 text-[11.5px] text-warn">{why}</span>
						{:else if here.length}
							<span class="mt-1 text-[11.5px] text-mist-600">{here.length} on this server</span>
						{/if}
					</button>
				{/each}
			</div>
		</section>
	{:else}
		<p class="mt-4 text-[13px] text-mist-600">No rule matches “{query.trim()}”.</p>
	{/each}
</Modal>
