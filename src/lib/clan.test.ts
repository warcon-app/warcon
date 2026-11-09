import { expect, test } from 'bun:test';
import { clanTag } from './clan';

test('clanTag reads a short bracketed tag at the front, in one case', () => {
	expect(clanTag('[ABC] Name')).toBe('abc');
	expect(clanTag('  {Wolf}Name')).toBe('wolf');
	expect(clanTag('(TAG) x')).toBe('tag');
	expect(clanTag('Name [ABC]')).toBeNull();
	expect(clanTag('[] Name')).toBeNull();
	expect(clanTag('[a tag far too long to be one] Name')).toBeNull();
});
