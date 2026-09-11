// The map rotation as it lives in ServerSettings.ini, for builds without the live rotation routes
// (live build CL-499480): the same entries the rotation routes expose, read from and written to the
// config document's [/Script/WDGame.WDServerMapRotationSettings] section.
import { getArray, getScalar, parseIni, setArrayInText, setScalarInText } from './config-doc';
import { S_ROTATION } from './config-fields';
import type { MapSelection } from './types';

export interface RotationDoc {
	enabled: boolean;
	mode: 'ordered' | 'random';
	entries: MapSelection[];
}

/** `(Map="Kavkazi",Experience="X",Lighting="L",ZoneAlternator="Z")`; several experiences join with `+`. */
export function parseRotationEntry(value: string): MapSelection | null {
	const inner = value.trim().replace(/^\(/, '').replace(/\)$/, '');
	const fields: Record<string, string> = {};
	for (const m of inner.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,)]*))/g)) {
		fields[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
	}
	if (!fields.map) return null;
	const exps = fields.experiences ?? fields.experience ?? '';
	return {
		map: fields.map,
		experiences: exps
			.split('+')
			.map((e) => e.trim())
			.filter(Boolean),
		lighting: fields.lighting ?? '',
		zoneAlternator: fields.zonealternator ?? ''
	};
}

export function formatRotationEntry(e: MapSelection): string {
	const parts = [`Map="${e.map}"`];
	if (e.experiences.length === 1) parts.push(`Experience="${e.experiences[0]}"`);
	else if (e.experiences.length > 1) parts.push(`Experiences="${e.experiences.join('+')}"`);
	if (e.lighting) parts.push(`Lighting="${e.lighting}"`);
	if (e.zoneAlternator) parts.push(`ZoneAlternator="${e.zoneAlternator}"`);
	return `(${parts.join(',')})`;
}

export function rotationFromText(text: string): RotationDoc {
	const doc = parseIni(text);
	const enabled = getScalar(doc, S_ROTATION, 'bEnabled');
	const mode = getScalar(doc, S_ROTATION, 'RotationMode');
	return {
		enabled: enabled === null ? true : /^true$/i.test(enabled),
		mode: /random/i.test(mode || '') ? 'random' : 'ordered',
		entries: getArray(doc, S_ROTATION, 'RotationEntries')
			.map(parseRotationEntry)
			.filter((e): e is MapSelection => !!e)
	};
}

/** Writes the rotation back into the document text, touching only the three rotation keys. */
export function rotationIntoText(text: string, r: RotationDoc): string {
	let out = setScalarInText(text, S_ROTATION, 'bEnabled', r.enabled ? 'True' : 'False');
	out = setScalarInText(
		out,
		S_ROTATION,
		'RotationMode',
		r.mode === 'random' ? 'Random' : 'Ordered'
	);
	return setArrayInText(out, S_ROTATION, 'RotationEntries', r.entries.map(formatRotationEntry));
}
