<script lang="ts">
	import { page } from '$app/state';
	import Mark from '$lib/components/Mark.svelte';
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-md rise panel text-center">
		<div class="mb-4 flex justify-center"><Mark size={40} /></div>
		<div class="mb-1 font-mono text-4xl font-semibold text-accent">{page.status}</div>
		<p class="mb-5 text-mist-400">{page.error?.message || 'Something went wrong.'}</p>
		<a href="/" class="btn btn-primary">Back to the dashboard</a>
	</div>
</div>
