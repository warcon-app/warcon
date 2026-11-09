<script lang="ts">
	import ReservedPage from '../../ReservedPage.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<ReservedPage
	entries={data.entries}
	lists={data.lists}
	org={data.org}
	servers={data.orgServers}
	group={data.group}
/>
