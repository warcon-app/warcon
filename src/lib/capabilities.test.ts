import { describe, expect, test } from 'bun:test';
import {
	BUILTIN_CAPABILITIES,
	CAPABILITIES,
	CAPABILITY_INFO,
	can,
	capabilitiesByGroup,
	capabilitySummary,
	knownCapabilities,
	parseCapabilities,
	VIEW
} from './capabilities';

describe('catalogue', () => {
	test('every capability has display info and lands in exactly one group', () => {
		const grouped = capabilitiesByGroup().flatMap((g) => g.caps);
		expect([...grouped].sort()).toEqual([...CAPABILITIES].sort());
		for (const c of CAPABILITIES) expect(CAPABILITY_INFO[c].label).toBeTruthy();
	});

	test('built-ins nest: viewer ⊂ operator ⊂ admin, and all include view', () => {
		const { viewer, operator, admin } = BUILTIN_CAPABILITIES;
		for (const c of viewer) expect(operator).toContain(c);
		for (const c of operator) expect(admin).toContain(c);
		expect(admin.length).toBe(CAPABILITIES.length);
		expect(viewer).toEqual([VIEW]);
	});
});

describe('parseCapabilities', () => {
	test('dedupes and returns canonical order', () => {
		expect(parseCapabilities(['bans.manage', 'server.view', 'bans.manage'])).toEqual([
			'server.view',
			'bans.manage'
		]);
	});

	test('rejects unknown names and non-lists', () => {
		expect(() => parseCapabilities(['server.view', 'nope'])).toThrow(/Unknown capability/);
		expect(() => parseCapabilities('server.view')).toThrow(/list/);
	});

	test('knownCapabilities drops what it does not recognise instead of throwing', () => {
		expect(knownCapabilities(['rcon.raw', 'old.thing', 3])).toEqual(['rcon.raw']);
		expect(knownCapabilities(null)).toEqual([]);
	});
});

describe('can', () => {
	test('works on arrays, sets and nothing', () => {
		expect(can(['chat.send'], 'chat.send')).toBe(true);
		expect(can(new Set(['chat.send']), 'bans.manage')).toBe(false);
		expect(can(null, 'server.view')).toBe(false);
	});

	test('summary uses labels in catalogue order', () => {
		expect(capabilitySummary(['bans.manage', 'server.view'])).toBe('View · Bans');
	});
});
