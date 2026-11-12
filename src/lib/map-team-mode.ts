import type { MapSelection } from './types';

export interface MapTeamMode {
	selection: MapSelection;
	mode: 'standard' | 'manual' | 'random';
	closedFaction?: string;
}

export const mapTeamKey = (s: MapSelection): string =>
	JSON.stringify([s.map, [...s.experiences].sort(), s.lighting, s.zoneAlternator]);

export interface MapTeamRule {
	enabled: boolean;
	config: Record<string, unknown>;
}

/** Two-team play is an automation setting, not a different KOTH experience ID. */
export function teamModeForSelection(
	selection: MapSelection,
	rule: MapTeamRule | null
): MapTeamMode | null {
	if (!rule?.enabled || rule.config.watchOnly === true) return null;
	const config = rule.config;
	const overrides = (config.mapOverrides ?? []) as MapTeamMode[];
	const override = overrides.find((o) => mapTeamKey(o.selection) === mapTeamKey(selection));
	if (override) return override.mode === 'standard' ? null : override;
	if (config.mapOnly === true || (!config.closedFaction && config.randomClosedFaction !== true))
		return null;
	return {
		selection,
		mode: config.randomClosedFaction === true ? 'random' : 'manual',
		...(typeof config.closedFaction === 'string' ? { closedFaction: config.closedFaction } : {})
	};
}
