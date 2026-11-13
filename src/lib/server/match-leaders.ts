import type { Rotation } from '$lib/types';
import { mapName } from '$lib/format';
import { lightingName } from './weather-cycle';
export { renderLeadersMessage } from '$lib/match-leaders';

/** The live ordered next entry is a prediction; random selection is not known yet. */
export function nextLeaderMap(rotation: Rotation | undefined): { nextMap?: string; nextWeather?: string } {
	if (!rotation?.enabled) return {};
	if (rotation.mode === 'random') return { nextMap: 'Random' };
	if (rotation.mode !== 'ordered' || rotation.nextIndex < 0) return {};
	const next = rotation.entries[rotation.nextIndex];
	if (!next || next.denied || !next.map) return {};
	return { nextMap: mapName(next.map), nextWeather: next.lighting ? lightingName(next.lighting) : undefined };
}
