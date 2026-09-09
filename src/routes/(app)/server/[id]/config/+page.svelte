<script lang="ts">
	import { rconGet, rconPost, errorMessage, ApiError } from '$lib/api';
	import { can } from '$lib/format';
	import { toast } from '$lib/toast.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';
	import ConfigForm from '$lib/components/ConfigForm.svelte';
	import type { ConfigDoc, ConfigResult, Status } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let admin = $derived(can(data.server.role, 'admin'));

	let tick = $state(24);
	let tickMin = $state(18);
	let tickMax = $state(30);
	let tickKnown = $state(false);
	let sponsor = $state('');
	let sponsorShown = $state('');
	let doc = $state<ConfigDoc | null>(null);
	let text = $state('');
	let force = $state(false);
	let docError = $state('');
	let result = $state<ConfigResult | null>(null);
	let failure = $state('');
	let lineErrors = $state<{ line?: number; message?: string }[]>([]);
	let busy = $state(false);
	let mode = $state<'form' | 'raw'>('form');

	let readOnly = $derived(!admin || !doc || !doc.writable);
	let dirty = $derived(!!doc && text !== doc.text);

	async function loadDoc(opts: { keepResult?: boolean } = {}) {
		if (!opts.keepResult) {
			result = null;
			failure = '';
			lineErrors = [];
		}
		try {
			doc = await rconGet<ConfigDoc>(id, 'config');
			text = doc.text;
			docError = '';
		} catch (err) {
			doc = null;
			text = '';
			docError = errorMessage(err);
		}
	}
	async function reload() {
		if (dirty && !(await confirmDialog('Reload from the server and drop your unapplied edits?')))
			return;
		await loadDoc();
	}
	function discard() {
		if (doc) text = doc.text;
		failure = '';
		lineErrors = [];
	}
	async function copyText() {
		try {
			await navigator.clipboard.writeText(text);
			toast('Config copied to the clipboard.', 'ok');
		} catch {
			toast('Could not copy; select the raw file and copy it by hand.', 'err');
		}
	}
	function download() {
		const blob = new Blob([text], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `ServerSettings-${data.server.name.replace(/[^\w.-]+/g, '_')}.ini`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	async function loadSponsor() {
		try {
			const s = await rconGet<{ imageUrl: string }>(id, 'sponsor');
			sponsor = s.imageUrl || '';
			sponsorShown = sponsor;
		} catch {
			/* ignore */
		}
	}
	async function loadTick() {
		try {
			const st = await rconGet<Status>(id, 'status');
			if (st.scoreTickMin) tickMin = st.scoreTickMin;
			if (st.scoreTickMax) tickMax = st.scoreTickMax;
			if (st.scoreTick !== null) {
				tick = st.scoreTick;
				tickKnown = true;
			}
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	$effect(() => {
		void Promise.all([loadTick(), loadSponsor(), loadDoc()]);
	});

	async function saveTick() {
		try {
			const r = await rconPost<{ message?: string }>(id, 'settings', { scoreTick: tick });
			toast(r?.message || 'Score tick saved.', 'ok');
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	async function saveSponsor() {
		try {
			const r = await rconPost<{ message?: string }>(id, 'setSponsor', {
				imageUrl: sponsor.trim()
			});
			toast(r?.message || 'Sponsor image saved.', 'ok');
			await loadSponsor();
		} catch (err) {
			toast(errorMessage(err), 'err');
		}
	}
	async function runConfig(action: 'configValidate' | 'configApply') {
		busy = true;
		result = null;
		failure = '';
		lineErrors = [];
		try {
			const r = await rconPost<ConfigResult>(
				id,
				action,
				action === 'configApply' ? { text, revision: doc?.revision, force } : { text }
			);
			if (r.conflict) {
				failure = `${r.errorMessage || 'The config changed on the server since you loaded it.'} Reload to see the current version, or tick Force to overwrite.`;
				return;
			}
			if (!r.ok) {
				failure = r.errorMessage || 'Rejected.';
				lineErrors = r.errors || [];
				return;
			}
			result = r;
			if (action === 'configApply' && doc) {
				doc.revision = r.revision;
				toast(`Config applied (revision ${r.revision}).`, 'ok');
				// Re-read so the change marks and revision reflect what the server actually kept.
				await loadDoc({ keepResult: true });
			} else {
				toast('Config is valid.', 'ok');
			}
		} catch (err) {
			failure = errorMessage(err);
			const body =
				err instanceof ApiError
					? (err.data as { error?: { body?: { errors?: { line?: number; message?: string }[] } } })
							?.error?.body
					: null;
			lineErrors = body?.errors || [];
		} finally {
			busy = false;
		}
	}
	const PIP: Record<string, string> = {
		applied: 'bg-ok/15 text-ok',
		'next-match': 'bg-info/15 text-info',
		'next-restart': 'bg-warn/15 text-warn',
		pending: 'bg-white/10 text-mist-400',
		shadowed: 'bg-override/15 text-override'
	};
</script>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
	<div class="panel">
		<span class="label-sm">Score tick (KOTH ScorePeriod)</span>
		<div class="flex items-center gap-3">
			<span class="text-mist-400">{tickMin}s</span>
			<input
				type="range"
				class="grow"
				min={tickMin}
				max={tickMax}
				step="1"
				bind:value={tick}
				disabled={!admin}
				onchange={saveTick}
			/>
			<span class="text-mist-400">{tickMax}s</span>
			<output class="w-10 font-mono">{tickKnown ? `${tick}s` : '—'}</output>
		</div>
		<p class="note">
			Live route (PATCH /v1/settings). Faster ticks reduce the cash multiplier; the game clamps to
			its allowed range.
		</p>
	</div>
	<div class="panel">
		<span class="label-sm">Sponsor image</span>
		<form
			class="join w-full"
			onsubmit={(e) => {
				e.preventDefault();
				void saveSponsor();
			}}
		>
			<input
				class="input"
				type="url"
				placeholder="https://…/banner.png (1024×256)"
				bind:value={sponsor}
				disabled={!admin}
			/>
			<button class="btn btn-primary" type="submit" disabled={!admin}>Save</button>
		</form>
		{#if sponsorShown}<img
				src={sponsorShown}
				alt=""
				class="mt-3 max-w-full rounded-card border border-black"
				referrerpolicy="no-referrer"
			/>{/if}
		<p class="note">
			The banner beside this server in the browser. Direct link to a 1024×256 PNG/JPEG on the
			server's image allow-list (catbox.moe, imgbb.com, postimg.cc).
		</p>
	</div>
</div>

<div class="mt-4 panel">
	<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
		<span class="label-sm mb-0">Config document (ServerSettings.ini)</span>
		<span class="text-[12.5px] text-mist-400"
			>Revision <span class="font-mono">{doc?.revision || (doc ? '(none)' : '—')}</span>{#if dirty}
				· <span class="text-accent">unapplied edits</span>{/if}</span
		>
		<span class="join ml-auto">
			<button
				class="btn btn-sm {mode === 'form' ? 'btn-primary' : ''}"
				onclick={() => (mode = 'form')}>Form</button
			>
			<button
				class="btn btn-sm {mode === 'raw' ? 'btn-primary' : ''}"
				onclick={() => (mode = 'raw')}>Raw file</button
			>
		</span>
	</div>
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<div class="join">
			<button class="btn btn-sm" onclick={reload}>Reload</button>
			<button class="btn btn-sm" disabled={!dirty} onclick={discard}>Discard edits</button>
			<button
				class="btn btn-sm"
				disabled={!admin || !doc || busy}
				onclick={() => runConfig('configValidate')}>Validate</button
			>
			<button
				class="btn btn-sm btn-primary"
				disabled={readOnly || busy}
				onclick={() => runConfig('configApply')}>Apply to server</button
			>
		</div>
		<div class="join">
			<button class="btn btn-sm" disabled={!doc} onclick={copyText}>Copy</button>
			<button class="btn btn-sm" disabled={!doc} onclick={download}>Download .ini</button>
		</div>
		<label class="inline-flex items-center gap-2 text-[12.5px]"
			><input type="checkbox" bind:checked={force} /> Force (ignore revision conflict)</label
		>
	</div>
	{#if mode === 'form' && doc}
		<ConfigForm
			bind:text
			serverText={doc.text}
			sections={doc.sections}
			shadowed={result?.shadowed ?? []}
			disabled={readOnly}
			tickRange={tickKnown ? { min: tickMin, max: tickMax } : null}
		/>
		<p class="note mt-4">
			Fields edit the file one line at a time, so keys the form does not know (rotation entries, ban
			and reserved lists, the RCON block) and any comments stay exactly as they are. Switch to Raw
			file to see or edit the whole document.
		</p>
	{:else}
		<textarea
			class="min-h-[420px] input font-mono text-[12.5px] leading-relaxed pointer-coarse:text-[16px]"
			rows="26"
			spellcheck="false"
			bind:value={text}
			readonly={readOnly}></textarea>
	{/if}

	{#if docError}
		<div class="mt-3 callout mb-0">
			No config document on this server ({docError}). Older WDRCON builds only expose the live
			settings above.
		</div>
	{:else if doc && !doc.writable}
		<div class="mt-3 callout mb-0">
			This server reports its config document as read-only (no -StandaloneConfig). Edits here cannot
			be applied.
		</div>
	{/if}
	{#each doc?.warnings ?? [] as w, i (i)}
		<div class="mt-3 callout mb-0">
			{typeof w === 'object' && w && 'message' in w
				? String((w as { message: unknown }).message)
				: String(w)}
		</div>
	{/each}
	{#if failure}<div class="mt-3 callout mb-0 border-danger/30 bg-danger/12">{failure}</div>{/if}
	{#each lineErrors as e, i (i)}
		<div class="mt-2 flex items-center gap-2 text-[13px]">
			<span class="pip {PIP['next-restart']}">line {e.line ?? '?'}</span><span
				>{e.message || String(e)}</span
			>
		</div>
	{/each}
	{#if result}
		<div class="mt-3 space-y-1.5">
			{#each result.outcomes as o (o.section)}
				<div class="flex flex-wrap items-center gap-2 text-[13px]">
					<span class="pip {PIP[o.state] || PIP.pending}">{o.state}</span><span class="font-mono"
						>{o.section}</span
					>{#if o.detail}<span class="text-mist-400">{o.detail}</span>{/if}
				</div>
			{/each}
			{#each result.shadowed as s (s.section + s.key)}
				<div class="flex flex-wrap items-center gap-2 text-[13px]">
					<span class="pip {PIP.shadowed}">patch override</span><span class="font-mono"
						>{s.section} {s.key}</span
					><span class="text-mist-400">declared {s.declared}, effective {s.effective}</span>
				</div>
			{/each}
			{#each result.warnings as w, i (i)}
				<div class="flex flex-wrap items-center gap-2 text-[13px]">
					<span class="pip {PIP.pending}">warning</span><span
						>{typeof w === 'object' && w && 'message' in w
							? String((w as { message: unknown }).message)
							: String(w)}</span
					>
				</div>
			{/each}
			{#if result.timingsMs?.total !== undefined}<div class="font-mono text-[12px] text-mist-600">
					{result.timingsMs.total} ms
				</div>{/if}
		</div>
	{/if}
	<p class="note">
		Apply sends the whole file back; the server validates it as one unit and reports per section
		whether it is live now, next match, or needs a restart. Requires the server launched with
		-StandaloneConfig=&lt;path&gt;; otherwise the document is read-only here.
	</p>
</div>
