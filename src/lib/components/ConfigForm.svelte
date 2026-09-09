<script lang="ts">
	// Typed fields over the ServerSettings.ini text. The text is the single source of truth: each
	// field reads its value out of it and every edit is written back as a one-line change, so the
	// raw view and the form never disagree and comments or array lines are never lost.
	import { getScalar, parseIni, setScalarInText } from '$lib/config-doc';
	import {
		APPLY_BADGES,
		FIELDS,
		GROUPS,
		appliesFor,
		fromIniValue,
		toIniValue,
		type ConfigField,
		type FieldValue
	} from '$lib/config-fields';
	import type { ConfigResult, ConfigSection } from '$lib/types';

	let {
		text = $bindable(),
		serverText,
		sections,
		shadowed = [],
		disabled = false,
		tickRange = null
	}: {
		text: string;
		/** the document as last loaded from (or applied to) the server, for change marks */
		serverText: string;
		sections: ConfigSection[];
		shadowed?: ConfigResult['shadowed'];
		disabled?: boolean;
		/** the score tick range the server reports, when known */
		tickRange?: { min: number; max: number } | null;
	} = $props();

	let parsed = $derived(parseIni(text));
	let serverParsed = $derived(parseIni(serverText));
	const current = (f: ConfigField) => fromIniValue(f, getScalar(parsed, f.section, f.ini));
	const onServer = (f: ConfigField) => fromIniValue(f, getScalar(serverParsed, f.section, f.ini));
	const shown = (f: ConfigField): FieldValue => current(f) ?? f.def;
	const inFile = (f: ConfigField) => current(f) !== undefined;
	const changed = (f: ConfigField) => current(f) !== onServer(f);

	function set(f: ConfigField, v: FieldValue) {
		text = setScalarInText(text, f.section, f.ini, toIniValue(f, v));
	}
	const num = (e: Event, f: ConfigField) => {
		const n = Number((e.currentTarget as HTMLInputElement).value);
		set(f, Number.isFinite(n) ? Math.max(f.min ?? -Infinity, n) : (f.def as number));
	};

	let shadowMap = $derived(
		new Map(shadowed.map((s) => [`${s.section}|${String(s.key).toLowerCase()}`, s]))
	);
	function badge(f: ConfigField): { label: string; cls: string; title: string } | null {
		const shadow = shadowMap.get(`${f.section}|${f.ini.toLowerCase()}`);
		if (shadow)
			return {
				label: 'overridden',
				cls: 'bg-override/15 text-override',
				title: `The value in force is "${shadow.effective}", set elsewhere and outranking this file. What you apply here is written but will not take effect.`
			};
		const a = appliesFor(f, sections);
		return a && APPLY_BADGES[a.state] ? { ...APPLY_BADGES[a.state], title: a.description } : null;
	}

	// Fields in display order, with min/max pairs folded into one row.
	type Row = { id: string; label: string; fields: ConfigField[]; help: string };
	let groups = $derived(
		GROUPS.map((g) => {
			const rows: Row[] = [];
			for (const f of FIELDS.filter((x) => x.group === g)) {
				const row = f.pair ? rows.find((r) => r.id === `pair:${f.pair}`) : undefined;
				if (row) {
					row.fields.push(f);
					row.help += ` ${f.help}`;
				} else {
					rows.push({
						id: f.pair ? `pair:${f.pair}` : f.key,
						label: f.pairLabel || f.label,
						fields: [f],
						help: f.help
					});
				}
			}
			return { name: g, rows };
		})
	);
	const sliderMin = (f: ConfigField) => tickRange?.min ?? f.min ?? 0;
	const sliderMax = (f: ConfigField) => tickRange?.max ?? f.max ?? 100;
</script>

<div class="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
	{#each groups as g (g.name)}
		<div class="border-b border-black pb-1 caps text-mist-400 md:col-span-2">{g.name}</div>
		{#each g.rows as row (row.id)}
			{@const first = row.fields[0]}
			{@const b = badge(first)}
			<div class={first.type === 'text' && !first.pair ? 'md:col-span-2' : ''}>
				<div class="mb-1.5 flex flex-wrap items-center gap-2">
					<span class="caps text-mist-400">{row.label}</span>
					{#if b}<span class="pip {b.cls}" title={b.title}>{b.label}</span>{/if}
					{#if row.fields.some(changed)}<span class="pip bg-accent/15 text-accent">modified</span
						>{/if}
					{#if !row.fields.every(inFile)}<span
							class="text-[11px] text-mist-600"
							title="The file does not set this key; the value shown is the game's default. Editing adds it."
							>not in file</span
						>{/if}
				</div>
				<div class="flex flex-wrap items-center gap-2">
					{#each row.fields as f (f.key)}
						{@const v = shown(f)}
						{#if f.type === 'bool'}
							<label class="inline-flex cursor-pointer items-center gap-2 text-[13.5px]">
								<input
									type="checkbox"
									checked={!!v}
									{disabled}
									onchange={(e) => set(f, e.currentTarget.checked)}
								/>
								{v ? 'On' : 'Off'}
							</label>
						{:else if f.type === 'enum'}
							<select
								class="input max-w-[220px]"
								value={String(v)}
								{disabled}
								onchange={(e) => set(f, e.currentTarget.value)}
							>
								{#each f.options ?? [] as [val, label] (val)}
									<option value={val}>{label}</option>
								{/each}
							</select>
						{:else if f.type === 'slider'}
							<span class="text-mist-400">{sliderMin(f)}{f.unit ?? ''}</span>
							<input
								type="range"
								class="grow"
								min={sliderMin(f)}
								max={sliderMax(f)}
								step="1"
								value={Number(v)}
								{disabled}
								oninput={(e) => num(e, f)}
							/>
							<span class="text-mist-400">{sliderMax(f)}{f.unit ?? ''}</span>
							<output class="w-12 font-mono tabular">{Number(v)}{f.unit ?? ''}</output>
						{:else if f.type === 'number'}
							{#if f.pair}<span class="caps text-[10px] text-mist-600"
									>{f.key.startsWith('min') ? 'min' : 'max'}</span
								>{/if}
							<input
								type="number"
								class="input max-w-[140px] font-mono tabular"
								min={f.min}
								step="1"
								value={Number(v)}
								{disabled}
								onchange={(e) => num(e, f)}
							/>
						{:else}
							<input
								type="text"
								class="input"
								value={String(v)}
								{disabled}
								placeholder={f.key === 'serverPassword' ? 'none (open server)' : ''}
								spellcheck="false"
								onchange={(e) => set(f, e.currentTarget.value)}
							/>
						{/if}
					{/each}
				</div>
				<p class="note mt-1.5">
					{row.help}
					{#if first.live}Also changeable at once, without a file apply, from {first.live}.{/if}
				</p>
			</div>
		{/each}
	{/each}
</div>
