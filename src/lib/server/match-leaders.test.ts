import { describe, expect, test } from 'bun:test';
import { nextLeaderMap, renderLeadersMessage } from './match-leaders';
import type { Rotation } from '$lib/types';
import { validateConfig } from './trigger-rules';

const leaders = { killsName: 'Carlo', kills: 41, cashName: 'Carlo', cash: 204000, streakName: 'Alex', streakCount: 17 };
describe('editable leaders message', () => {
	test('older rules retain their default message, including the optional streak', () => {
		expect(renderLeadersMessage(undefined, leaders)).toBe('LEADERS\nCarlo — 41 kills\nCarlo — $204,000 cash\nAlex — 17 kill streak\n\nNEXT: —\nWeather: —');
		expect(renderLeadersMessage(undefined, { ...leaders, streakCount: 0 })).toBe('LEADERS\nCarlo — 41 kills\nCarlo — $204,000 cash\n— — — kill streak\n\nNEXT: —\nWeather: —');
	});
	test('keeps the separator in existing single-line templates', () => {
		expect(renderLeadersMessage('Leaders: {kills_name}{streak}', leaders)).toBe('Leaders: Carlo | Alex — 17 kill streak');
	});
	test('renders a custom template safely and makes unavailable streaks explicit', () => {
		expect(renderLeadersMessage('{kills_name}: {kills} / {cash_name}: {cash} / {streak_name}: {streak_count}', { ...leaders, killsName: '{cash}', streakCount: 0 })).toBe('{cash}: 41 / Carlo: 204,000 / —: —');
	});
	test('shows next map only when the live ordered rotation has an eligible next entry', () => {
		const rotation = { enabled: true, mode: 'ordered', nowIndex: 0, nextIndex: 1, entries: [
			{ map: 'Ozeti', experiences: [], lighting: '', zoneAlternator: '', denied: false, status: 'now' },
			{ map: 'Bakurani', experiences: [], lighting: 'DayEarlyClear', zoneAlternator: '', denied: false, status: 'next' }
		] } satisfies Rotation;
		expect(nextLeaderMap(rotation)).toEqual({ nextMap: 'Bakurani', nextWeather: 'Day Early Clear' });
		expect(nextLeaderMap({ ...rotation, mode: 'random' })).toEqual({ nextMap: 'Random' });
		expect(nextLeaderMap({ ...rotation, nextIndex: -1 })).toEqual({});
		expect(renderLeadersMessage('{next_map} / {next_weather}', { ...leaders, ...nextLeaderMap(rotation) })).toBe('Bakurani / Day Early Clear');
	});
	test('the server preserves a configured template when the option is disabled', () => {
		expect(validateConfig('match_broadcast', { leadersAt100: true, leadersMessage: 'Winner {kills_name}' })).toMatchObject({ leadersAt100: true, leadersMessage: 'Winner {kills_name}' });
		expect(validateConfig('match_broadcast', { endMessage: 'Done', leadersAt100: false, leadersMessage: 'old' })).toMatchObject({ leadersMessage: 'old' });
	});
});
