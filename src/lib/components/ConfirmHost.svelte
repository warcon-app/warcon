<script lang="ts">
	import Modal from './Modal.svelte';
	import { confirmState, settleConfirm } from '$lib/confirm.svelte';
</script>

{#if confirmState.current}
	{@const c = confirmState.current}
	<Modal title={c.title} onclose={() => settleConfirm(false)}>
		<p class="m-0 leading-relaxed">{c.message}</p>
		{#snippet actions()}
			<button type="button" class="btn" data-close onclick={() => settleConfirm(false)}
				>Cancel</button
			>
			<button
				type="button"
				class="btn {c.danger ? 'btn-danger' : 'btn-primary'}"
				onclick={() => settleConfirm(true)}>{c.okLabel}</button
			>
		{/snippet}
	</Modal>
{/if}
