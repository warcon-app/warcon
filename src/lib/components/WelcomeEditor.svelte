<script lang="ts">
	// The text of the game's welcome popup: its lines in a text box, one line of the popup each,
	// beside the popup as a player would read it. The config document stays the single source: the
	// lines are read out of it and written back as one array block, so this box, the raw file and
	// the rest of the form never disagree.
	import { tick, untrack } from 'svelte';
	import { sameLines, welcomeLinesFromText, welcomeLinesIntoText } from '$lib/welcome-doc';
	import {
		checkWelcome,
		closeWelcomeTags,
		formatWelcome,
		normaliseBreaks,
		plainWelcomeLine,
		previewWelcomeLine,
		splitWelcomeLines,
		straightenQuotes,
		visibleLength,
		type PreviewRun,
		type WelcomeFormat,
		type WelcomeIssue,
		type WelcomeLimits
	} from '$lib/welcome-text';

	let {
		text = $bindable(),
		limits,
		disabled = false,
		on = true,
		closeDelay = 0
	}: {
		/** the config document */
		text: string;
		limits: WelcomeLimits;
		disabled?: boolean;
		/** whether the popup is switched on; off, the preview says that nobody sees it */
		on?: boolean;
		/** seconds the popup's Close button stays locked */
		closeDelay?: number;
	} = $props();

	const EXAMPLE = '<Header>Welcome to the server</>\nBe kind, play the objective and have fun.';

	const linesIn = (doc: string) => welcomeLinesFromText(doc) ?? [];
	let inDocument = $derived(linesIn(text));
	// What the box holds: the document's lines, and whatever typing leaves that is not a line of the
	// popup yet (the empty line a caret waits on).
	let draft = $state(untrack(() => linesIn(text).join('\n')));
	$effect(() => {
		const lines = inDocument;
		// The document changed under the box (a reload, Discard edits, the raw file): show its lines.
		untrack(() => {
			if (!sameLines(splitWelcomeLines(draft), lines)) draft = lines.join('\n');
		});
	});
	let lines = $derived(splitWelcomeLines(draft));
	let rows = $derived(draft.split('\n'));
	let issues = $derived(checkWelcome(lines, limits));
	/** the worst thing said of each line, for the numbers beside the box */
	let marks = $derived.by(() => {
		const out: Record<number, WelcomeIssue['level']> = {};
		for (const i of issues) if (i.line !== null && out[i.line] !== 'refused') out[i.line] = i.level;
		return out;
	});

	let area = $state<HTMLTextAreaElement>();
	let gutter = $state<HTMLDivElement>();
	let caret = $state(1);
	let caretLength = $derived(visibleLength(rows[caret - 1] ?? ''));
	function noteCaret() {
		if (area) caret = area.value.slice(0, area.selectionStart).split('\n').length;
	}
	function follow() {
		if (area && gutter) gutter.scrollTop = area.scrollTop;
	}

	function take(value: string) {
		draft = value;
		const next = splitWelcomeLines(value);
		if (!sameLines(next, inDocument)) text = welcomeLinesIntoText(text, next);
	}
	function typed(e: Event & { currentTarget: HTMLTextAreaElement }) {
		const el = e.currentTarget;
		// A paste can carry line breaks a text box does not show as lines (a form feed, a line
		// separator); the popup would break there, so the box does too.
		const value = normaliseBreaks(el.value);
		if (value !== el.value) el.value = value;
		take(value);
		noteCaret();
	}

	/**
	 * Puts `value` in the box as one edit of the browser's own where it can, so that undo steps back
	 * over a style or a fix like over anything typed; then selects `from` to `to`.
	 */
	async function put(value: string, from: number, to: number) {
		const el = area;
		if (!el || disabled) return;
		const old = el.value;
		if (old !== value) {
			let head = 0;
			while (head < old.length && head < value.length && old[head] === value[head]) head++;
			let tail = 0;
			while (
				tail < old.length - head &&
				tail < value.length - head &&
				old[old.length - 1 - tail] === value[value.length - 1 - tail]
			)
				tail++;
			const middle = value.slice(head, value.length - tail);
			el.focus();
			el.setSelectionRange(head, old.length - tail);
			try {
				if (middle) document.execCommand('insertText', false, middle);
				else document.execCommand('delete');
			} catch {
				// no editing commands here: the value is set below
			}
			if (el.value !== value) el.value = value;
			take(value);
		}
		await tick();
		el.focus();
		el.setSelectionRange(from, to);
		noteCaret();
	}

	function style(format: WelcomeFormat) {
		if (!area) return;
		const next = formatWelcome(area.value, area.selectionStart, area.selectionEnd, format);
		void put(next.value, next.selStart, next.selEnd);
	}
	function keys(e: KeyboardEvent) {
		if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || disabled) return;
		const key = e.key.toLowerCase();
		if (key !== 'b' && key !== 'i') return;
		e.preventDefault();
		style({ tag: key === 'b' ? 'Bold' : 'Italic' });
	}

	let colour = $state('#d4a843');
	let size = $state(16);
	const sizeInRange = () =>
		Math.min(limits.maxFontSize, Math.max(limits.minFontSize, Math.round(Number(size)) || 0));

	const FIXES: Record<NonNullable<WelcomeIssue['fix']>, [string, (line: string) => string]> = {
		plain: ['Keep as typed', plainWelcomeLine],
		quotes: ['Straighten quotes', straightenQuotes],
		closers: ['Close with </>', closeWelcomeTags]
	};
	const startOf = (all: string[], line: number) =>
		all.slice(0, line - 1).reduce((n, row) => n + row.length + 1, 0);
	function fix(issue: WelcomeIssue) {
		if (!area || issue.line === null || !issue.fix) return;
		const all = area.value.split('\n');
		const fixed = FIXES[issue.fix][1](all[issue.line - 1] ?? '');
		all[issue.line - 1] = fixed;
		// the caret at the end of the line, to carry on from
		const end = startOf(all, issue.line) + fixed.length;
		void put(all.join('\n'), end, end);
	}
	function goTo(line: number) {
		if (!area) return;
		const all = area.value.split('\n');
		const start = startOf(all, line);
		area.focus();
		area.setSelectionRange(start, start + (all[line - 1]?.length ?? 0));
		const height = parseFloat(getComputedStyle(area).lineHeight) || 20;
		area.scrollTop = Math.max(0, (line - 3) * height);
		follow();
		noteCaret();
	}

	// The popup's own styles, as the official console draws them: plain text at 14, a header at 20.
	// The game has its own font, so this shows sizes and colours against each other, not pixels.
	const look = (r: PreviewRun) =>
		`font-size:${r.size ?? (r.header ? 20 : 14)}px;font-weight:${r.bold ? 600 : 400};font-style:${
			r.italic ? 'italic' : 'normal'
		}${r.color ? `;color:${r.color}` : ''}`;
	let shown = $derived(lines.slice(0, limits.maxLines).map((l) => previewWelcomeLine(l, limits)));
</script>

<div class="grid grid-cols-1 gap-x-6 gap-y-4 lg:grid-cols-2">
	<div class="min-w-0">
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<span class="join">
				<button
					type="button"
					class="btn btn-sm"
					{disabled}
					title="The popup's title style"
					onclick={() => style({ tag: 'Header' })}>Header</button
				>
				<button
					type="button"
					class="btn btn-sm"
					{disabled}
					title="Bold (Ctrl+B)"
					onclick={() => style({ tag: 'Bold' })}>Bold</button
				>
				<button
					type="button"
					class="btn btn-sm"
					{disabled}
					title="Italic (Ctrl+I)"
					onclick={() => style({ tag: 'Italic' })}>Italic</button
				>
			</span>
			<span class="inline-flex items-center gap-1">
				<input
					type="color"
					class="h-[30px] w-9 cursor-pointer rounded-ctl border border-black bg-ink-950 p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
					bind:value={colour}
					{disabled}
					aria-label="Text colour"
				/>
				<button
					type="button"
					class="btn btn-sm"
					{disabled}
					title="Give the selection this colour"
					onclick={() => style({ tag: 'text', color: colour.toUpperCase() })}>Colour</button
				>
			</span>
			<span class="inline-flex items-center gap-1">
				<input
					type="number"
					class="h-[30px] input w-[62px] px-2 py-0 font-mono text-[12.5px] tabular disabled:cursor-not-allowed disabled:opacity-40"
					min={limits.minFontSize}
					max={limits.maxFontSize}
					step="1"
					bind:value={size}
					{disabled}
					aria-label="Font size"
				/>
				<button
					type="button"
					class="btn btn-sm"
					{disabled}
					title="Give the selection this size ({limits.minFontSize} to {limits.maxFontSize}; plain text is 14, a header 20)"
					onclick={() => style({ tag: 'text', size: sizeInRange() })}>Size</button
				>
			</span>
			<button
				type="button"
				class="btn btn-sm"
				{disabled}
				title="Take the style off the selection"
				onclick={() => style(null)}>Plain</button
			>
		</div>
		<div
			class="flex overflow-hidden rounded-ctl border border-black bg-ink-950 shadow-[inset_0_1px_2px_rgb(0_0_0/0.5)] focus-within:border-accent"
		>
			<div
				bind:this={gutter}
				aria-hidden="true"
				class="shrink-0 overflow-hidden border-r border-black/60 py-2 pr-2 pb-6 pl-2.5 text-right font-mono text-[12.5px] leading-[20px] text-mist-600 tabular select-none pointer-coarse:text-[16px] pointer-coarse:leading-[24px]"
			>
				{#each rows as _, i (i)}
					{@const mark = marks[i + 1]}
					<!-- red: refused, or a line past the limit of lines; brass: shown as typed; faint: the
					     empty lines at the end, which are no lines of the popup -->
					<div
						class={mark === 'refused' || (i >= limits.maxLines && i < lines.length)
							? 'text-danger'
							: mark === 'typed'
								? 'text-warn'
								: i >= lines.length
									? 'opacity-40'
									: ''}
					>
						{i + 1}
					</div>
				{/each}
			</div>
			<!-- No ligatures: the mono font draws </> and // as one glyph each, and here every character counts. -->
			<textarea
				bind:this={area}
				class="min-h-[212px] min-w-0 grow resize-y bg-transparent px-2.5 py-2 font-mono text-[12.5px] leading-[20px] text-mist-100 outline-none [font-variant-ligatures:none] placeholder:text-mist-600 pointer-coarse:text-[16px] pointer-coarse:leading-[24px]"
				rows="10"
				wrap="off"
				spellcheck="false"
				autocapitalize="off"
				aria-label="Welcome popup text, one line of the popup per line"
				placeholder={EXAMPLE}
				value={draft}
				readonly={disabled}
				oninput={typed}
				onscroll={follow}
				onkeydown={keys}
				onkeyup={noteCaret}
				onclick={noteCaret}
				onfocus={noteCaret}
				onselect={noteCaret}></textarea>
		</div>
		<div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-mist-400">
			<span class={lines.length > limits.maxLines ? 'text-danger' : ''}
				>{lines.length} of {limits.maxLines} lines</span
			>
			<span class={caretLength > limits.maxLineLength ? 'text-danger' : ''}
				>line {caret}: {caretLength} of {limits.maxLineLength} characters</span
			>
		</div>
		{#if issues.length}
			<ul class="mt-2.5 space-y-1.5">
				{#each issues as issue, i (i)}
					<li class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
						<span
							class="pip min-w-[64px] {issue.level === 'refused'
								? 'bg-danger/15 text-danger'
								: 'bg-warn/15 text-warn'}">{issue.level === 'refused' ? 'refused' : 'note'}</span
						>
						{#if issue.line !== null}
							{@const line = issue.line}
							<button
								type="button"
								class="min-w-0 cursor-pointer text-left hover:text-white"
								title="Go to line {line}"
								onclick={() => goTo(line)}>{issue.message}</button
							>
						{:else}
							<span class="min-w-0">{issue.message}</span>
						{/if}
						{#if issue.fix && !disabled}
							<button type="button" class="btn btn-sm" onclick={() => fix(issue)}
								>{FIXES[issue.fix][0]}</button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	<div class="min-w-0">
		<div class="mb-2 flex h-[30px] items-center gap-2">
			<span class="caps text-mist-400">As players see it</span>
			{#if !on}<span class="badge">off</span>{/if}
		</div>
		<div
			class="max-h-[420px] min-h-[212px] overflow-y-auto rounded-card border border-black bg-ink-950 px-5 py-4 {on
				? ''
				: 'opacity-50'}"
		>
			{#each shown as line, i (i)}
				<div class="min-h-[21px] leading-[1.5] break-words whitespace-pre-wrap">
					{#each line.runs as run, j (j)}<span style={look(run)}>{run.text}</span
						>{/each}{#if line.cut}<span
							class="text-danger"
							title="Cut here: the popup shows {limits.maxLineLength} characters of a line">…</span
						>{/if}
				</div>
			{:else}
				<p class="text-[13px] text-mist-600">No text yet.</p>
			{/each}
		</div>
		<p class="mt-1.5 text-[12px] text-mist-400">
			{#if !on}The popup is switched off: nobody sees this until it is on.{:else if closeDelay > 0}Close
				stays locked for {closeDelay} s.{:else}Players can close it at once.{/if}
			Sizes and colours are as the popup takes them; the game draws it in its own font.
		</p>
	</div>
</div>
<p class="note mt-3">
	One line here is one line of the popup: an empty line leaves a gap, a long one wraps, and the
	popup scrolls when the text is taller than it. Style a stretch with
	<span class="chip">&lt;Header&gt;</span>, <span class="chip">&lt;Bold&gt;</span>,
	<span class="chip">&lt;Italic&gt;</span> or
	<span class="chip">&lt;text color="#RRGGBB" size="16" fontface="Bold"&gt;</span>, each closed by
	<span class="chip">&lt;/&gt;</span>; the buttons write them around the selection, or the whole
	line. A tag does not go inside another, and a Header takes no colour or size. Anything else in
	angle brackets, a link included, shows as typed and cannot be clicked. For the characters &lt;
	&gt; &amp; themselves, write <span class="chip">&amp;lt;</span>
	<span class="chip">&amp;gt;</span> <span class="chip">&amp;amp;</span>.
</p>
