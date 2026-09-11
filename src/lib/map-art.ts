// Map art mirrored from the official WARDOGS RCON console (scripts/fetch-map-art.sh puts it in
// static/maps). One image per map, lighting preset and crop; the console's own lookup order is
// kept: the exact lighting, then DayClear, under the server's map id and then its display name.

export type MapArtVariant = '720' | 'square' | 'wide';

/** Server map id <-> display name, both ways, so either spelling finds the folder. */
const ALIAS: Record<string, string> = {
	Kavkazi: 'Bakurani',
	Bakurani: 'Kavkazi',
	Europe: 'Ozeti',
	Ozeti: 'Europe',
	NorthAmerica: 'Zestafona',
	Zestafona: 'NorthAmerica'
};

const FALLBACK_LIGHTING = 'DayClear';

/** Candidate URLs, most specific first; empty when there is no map. */
export function mapArtCandidates(
	map: string | null | undefined,
	lighting: string | null | undefined,
	variant: MapArtVariant
): string[] {
	if (!map) return [];
	const dirs = [map, ALIAS[map]].filter(Boolean) as string[];
	const lights = [lighting, FALLBACK_LIGHTING].filter(
		(l, i, all): l is string => !!l && all.indexOf(l) === i
	);
	const out: string[] = [];
	for (const light of lights)
		for (const dir of dirs)
			out.push(`/maps/${encodeURIComponent(dir)}/${encodeURIComponent(light)}-${variant}.webp`);
	return out;
}
