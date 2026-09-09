<script lang="ts">
	import ListPage from '../ListPage.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<ListPage kind="ban" entries={data.entries} lists={data.lists} org={data.org} />
