// Map art mirrored from the official WARDOGS RCON console (scripts/fetch-map-art.sh puts it in
// static/maps). One image per map, lighting preset and crop; the console's own lookup order is
// kept: the exact lighting, then DayClear, under the server's map id and then its display name.

import { MAP_DISPLAY } from './format';

export type MapArtVariant = '720' | 'square' | 'wide';

/**
 * The folders under static/maps are named by map id (Kavkazi); a live server reports the
 * display name (Bakurani), and a rotation entry the id. Both spellings resolve, id first.
 */
const ID_OF: Record<string, string> = Object.assign(
	Object.create(null),
	Object.fromEntries(Object.entries(MAP_DISPLAY).map(([id, name]) => [name, id]))
);

const FALLBACK_LIGHTING = 'DayClear';

/** Candidate URLs, most specific first; empty when there is no map. */
export function mapArtCandidates(
	map: string | null | undefined,
	lighting: string | null | undefined,
	variant: MapArtVariant
): string[] {
	if (!map) return [];
	// The id's folder first: that is the one on disk, and a consumer that can try only one URL
	// (a Discord embed) takes the head of this list.
	const id = ID_OF[map] ?? map;
	const dirs = [id, MAP_DISPLAY[id]].filter(
		(d, i, all): d is string => !!d && all.indexOf(d) === i
	);
	const lights = [lighting, FALLBACK_LIGHTING].filter(
		(l, i, all): l is string => !!l && all.indexOf(l) === i
	);
	const out: string[] = [];
	for (const light of lights)
		for (const dir of dirs)
			out.push(`/maps/${encodeURIComponent(dir)}/${encodeURIComponent(light)}-${variant}.webp`);
	return out;
}
