<script lang="ts">
	/** true = live, false = unreachable, undefined = unknown. */
	let { ok, class: cls = '' }: { ok?: boolean; class?: string } = $props();
</script>

<span
	class="inline-block h-2 w-2 shrink-0 rounded-full {ok === true
		? 'pulse-ok'
		: ok === false
			? 'bg-danger'
			: 'bg-mist-600'} {cls}"
	aria-label={ok === true ? 'live' : ok === false ? 'unreachable' : 'unknown'}
></span>
