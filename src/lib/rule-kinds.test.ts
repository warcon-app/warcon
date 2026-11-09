import { describe, expect, test } from 'bun:test';
import { FAILURES_ONLY, NO_ACTIONS, ONE_PER_SERVER, RULE_GROUPS, RULE_KINDS } from './rule-kinds';
import { TRIGGER_KINDS, TRIGGER_LABELS } from './server/trigger-rules';

describe('the kinds of rule the panel lists', () => {
	test('every kind the server runs, once, in a group, under the name the server gives it', () => {
		expect(RULE_KINDS.map((k) => k.kind).sort()).toEqual([...TRIGGER_KINDS].sort());
		for (const k of RULE_KINDS) {
			expect(RULE_GROUPS).toContain(k.group);
			expect(k.label).toBe(TRIGGER_LABELS[k.kind]);
		}
		for (const kind of FAILURES_ONLY) expect(TRIGGER_KINDS).toContain(kind);
		for (const kind of ONE_PER_SERVER) expect(TRIGGER_KINDS).toContain(kind);
		for (const kind of NO_ACTIONS) expect(TRIGGER_KINDS).toContain(kind);
	});

	test('listed group by group, in the order the groups are shown', () => {
		const groups = RULE_KINDS.map((k) => k.group).filter((g, i, all) => g !== all[i - 1]);
		expect(groups).toEqual(RULE_GROUPS);
	});
});
