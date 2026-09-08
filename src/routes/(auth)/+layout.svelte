<script lang="ts">
	import Mark from '$lib/components/Mark.svelte';
	import type { LayoutProps } from './$types';
	let { data, children }: LayoutProps = $props();
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-[400px] rise">
		<div class="mb-6 flex items-center justify-center gap-3">
			<Mark size={40} />
			<div>
				<div class="font-display text-2xl font-semibold tracking-[0.08em] uppercase">
					{data.appName}
				</div>
				<div class="caps text-mist-400">Server administration</div>
			</div>
		</div>
		<div class="panel p-6 shadow-pop">
			{@render children()}
		</div>
	</div>
</div>
