import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
	// When the game adds a preset, add it to the mock and to scripts/fetch-map-art.sh, then run it.
	test('every lighting the mock serves has its own art for every map and crop', () => {
		const lightings = catalog('lightings', 'lightings');
		expect(lightings).toContain('DayLateRain');
		const missing: string[] = [];
		for (const map of catalog('maps', 'maps'))
			for (const lighting of lightings)
				for (const variant of VARIANTS) {
					const own = mapArtCandidates(map, lighting, variant)[0];
					if (!existsSync(join(STATIC, own))) missing.push(own);
				}
		expect(missing).toEqual([]);
	});
});
