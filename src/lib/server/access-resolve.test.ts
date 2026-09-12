import { describe, expect, test } from 'bun:test';
import { CAPABILITIES } from '../capabilities';
import { resolveAccess } from './access-resolve';

const grant = { roleId: 'r1', roleName: 'Trial staff', capabilities: ['server.view', 'chat.send'] };

describe('resolveAccess', () => {
	test('managers hold every capability regardless of grants', () => {
		const a = resolveAccess({ manager: true, grant: null })!;
		expect(a.manager).toBe(true);
		expect(a.caps.size).toBe(CAPABILITIES.length);
		expect(a.roleName).toBe('owner');
	});

	test('a grant yields exactly its role capabilities and name', () => {
		const a = resolveAccess({ manager: false, grant })!;
		expect([...a.caps]).toEqual(['server.view', 'chat.send']);
		expect(a.roleName).toBe('Trial staff');
		expect(a.roleId).toBe('r1');
		expect(a.manager).toBe(false);
	});

	test('no grant and not a manager means no access', () => {
		expect(resolveAccess({ manager: false, grant: null })).toBeNull();
	});

	test('a suspended org closes the door even for its owners', () => {
		expect(resolveAccess({ manager: true, suspended: true })).toBeNull();
		expect(resolveAccess({ manager: false, suspended: true, grant })).toBeNull();
	});

	test('stored capabilities that are no longer known are ignored, not fatal', () => {
		const a = resolveAccess({
			manager: false,
			grant: { ...grant, capabilities: ['server.view', 'retired.thing', 42] }
		})!;
		expect([...a.caps]).toEqual(['server.view']);
		expect(
			resolveAccess({ manager: false, grant: { ...grant, capabilities: 'junk' } })!.caps.size
		).toBe(0);
	});
});
