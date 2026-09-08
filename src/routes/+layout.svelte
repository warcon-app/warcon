<script lang="ts">
	import '../app.css';
	import Toasts from '$lib/components/Toasts.svelte';
	import ConfirmHost from '$lib/components/ConfirmHost.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<svelte:head>
	<title>{data.appName}</title>
</svelte:head>

{@render children()}
<Toasts />
<ConfirmHost />
