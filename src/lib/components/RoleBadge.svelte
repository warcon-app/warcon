<script lang="ts">
	import Badge from './Badge.svelte';
	let { role }: { role: string } = $props();
</script>

<Badge tone={role === 'admin' || role === 'owner' ? 'accent' : role === 'operator' ? 'info' : ''}
	>{role}</Badge
>
