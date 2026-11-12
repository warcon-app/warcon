import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { takesLighting } from './format';
import { mapArtCandidates, type MapArtVariant } from './map-art';
import { MOCK_PASSWORD, mockHandle } from './server/mockgame';

const STATIC = join(import.meta.dir, '../../static');
const VARIANTS: MapArtVariant[] = ['720', 'square', 'wide'];

function catalog(route: string, field: string): string[] {
	const res = mockHandle('map-art-test', 'GET', `/v1/catalog/${route}`, {
		authorization: `Bearer ${MOCK_PASSWORD}`
	});
	return (JSON.parse(res.text)[field] as { id: string }[]).map((x) => x.id);
}

describe('map art', () => {
	// When the game adds a map or a preset, add it to the mock and to scripts/fetch-map-art.sh, then
	// run it. A map that takes only some of the lightings (Sabatulo) has art for those alone.
	test('every lighting the mock serves has its own art for every map that takes it, and crop', () => {
		const lightings = catalog('lightings', 'lightings');
		expect(lightings).toContain('DayLateRain');
		const maps = catalog('maps', 'maps');
		expect(maps).toContain('Russia');
		const missing: string[] = [];
		for (const map of maps)
			for (const lighting of lightings.filter((l) => takesLighting(map, l)))
				for (const variant of VARIANTS) {
					const own = mapArtCandidates(map, lighting, variant)[0];
					if (!existsSync(join(STATIC, own))) missing.push(own);
				}
		expect(missing).toEqual([]);
	});

	test('Sabatulo resolves to its id’s folder, whichever name it comes under', () => {
		const own = ['/maps/Russia/DayLateRain-wide.webp', '/maps/Sabatulo/DayLateRain-wide.webp'];
		const fallback = ['/maps/Russia/DayClear-wide.webp', '/maps/Sabatulo/DayClear-wide.webp'];
		expect(mapArtCandidates('Russia', 'DayLateRain', 'wide')).toEqual([...own, ...fallback]);
		expect(mapArtCandidates('Sabatulo', 'DayLateRain', 'wide')).toEqual([...own, ...fallback]);
		expect(existsSync(join(STATIC, own[0]))).toBe(true);
	});
});
