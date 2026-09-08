import type { Catalog, FactionScore } from './types';

export const fmtTime = (value: string | number | Date | null | undefined): string => {
	if (value === null || value === undefined || value === '') return '—';
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return String(value);
	return d.toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
};

export const fmtDuration = (sec: number | null | undefined): string => {
	if (sec === null || sec === undefined) return '—';
	const s = Math.max(0, Math.floor(sec));
	const hh = Math.floor(s / 3600);
	const mm = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

export const fmtNum = (n: number | null | undefined): string =>
	n === null || n === undefined ? '—' : Number(n).toLocaleString();

export function prettify(id: string | null | undefined): string {
	return String(id || '')
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim();
}

export const initials = (name: string): string =>
	name
		.split(/\s+/)
		.map((w) => w[0] || '')
		.join('')
		.slice(0, 2)
		.toUpperCase() || '?';

// --- game labels ---------------------------------------------------------------

export const MAP_DISPLAY: Record<string, string> = {
	Kavkazi: 'Bakurani',
	Europe: 'Ozeti',
	NorthAmerica: 'Zestafona'
};
export const isMod = (id: string) => /infantry|hardcore/i.test(id);

export const mapLabel = (catalog: Catalog, id: string) =>
	MAP_DISPLAY[id] || catalog.maps.find((m) => m.id === id)?.display || prettify(id) || '—';

export const lightingLabel = (catalog: Catalog, id: string) =>
	catalog.lightings.find((l) => l.id === id)?.display || prettify(id) || '—';

export const expLabel = (catalog: Catalog, id: string) => {
	if (/koth/i.test(id)) return isMod(id) ? prettify(id.replace(/^KOTH_/i, '')) : 'King of the Hill';
	return catalog.experiences.find((e) => e.id === id)?.display || prettify(id);
};

export const expSetLabel = (catalog: Catalog, ids: string[] | null | undefined) => {
	const list = ids || [];
	if (!list.length) return '—';
	const mode = list.find((i) => !isMod(i));
	return [
		mode ? expLabel(catalog, mode) : null,
		...list.filter(isMod).map((i) => expLabel(catalog, i))
	]
		.filter(Boolean)
		.join(' + ');
};

export const zoneLabel = (tag: string | null | undefined) => {
	if (!tag || /^none$/i.test(tag)) return 'Default';
	return prettify(
		String(tag)
			.replace(/^ZoneAlternator\./i, '')
			.replace(/\./g, ' ')
	);
};

const FACTION_FALLBACK: Record<string, string> = { RED: '#D86060', BLU: '#5B95D8', GRN: '#7BC462' };
export function factionColor(
	faction: string | null | undefined,
	scores?: FactionScore[] | null
): string {
	if (!faction) return '#5E5E66';
	const hit = (scores || []).find((s) => s.name === faction);
	return hit?.colorHex || FACTION_FALLBACK[faction] || '#5E5E66';
}

export const ROLE_RANK: Record<string, number> = { viewer: 1, operator: 2, admin: 3 };
export const can = (role: string | null | undefined, need: string) =>
	(ROLE_RANK[role || ''] || 0) >= (ROLE_RANK[need] || 99);

export function prettyJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}
