// The roles a webhook pings for Staff calls: what counts as a role's ID, how several are read,
// which of a stored list are pinged, and the one mention built from each.
import { describe, expect, test } from 'bun:test';
import {
	MAX_STAFF_ROLES,
	parseRoleId,
	parseRoleIds,
	roleMention,
	rolesToPing
} from './discord-role';

const A = '123456789012345678';
const B = '223456789012345678';
const C = '9223372036854775807';

describe('a Discord role ID', () => {
	test('the number as Discord copies it, or the mention it writes', () => {
		expect(parseRoleId(A)).toBe(A);
		expect(parseRoleId('  1234567890123456789 ')).toBe('1234567890123456789');
		expect(parseRoleId(`<@&${A}>`)).toBe(A);
		expect(parseRoleId(` <@&${C}> `)).toBe(C);
	});

	test('anything else is none: a name, everyone, a user or channel mention, a number as a number', () => {
		for (const no of [
			'',
			' ',
			'Staff',
			'@Staff',
			'@everyone',
			'@here',
			`<@${A}>`,
			`<@!${A}>`,
			`<#${A}>`,
			`<@&${A}`,
			`<@&${A}> <@&${B}>`,
			`<@&${A}>@everyone`,
			`${A} @everyone`,
			'1234567890123456',
			// past the largest number an ID can be: Discord refuses the whole message for one
			'9223372036854775808',
			'12345678901234567890',
			'<@&12345678901234567890>',
			'01234567890123456',
			'00000000000000000',
			'12345678901234567a',
			'１２３４５６７８９０１２３４５６７８',
			`${A}\n@everyone`,
			123456789012345678,
			123456789012345678n,
			null,
			undefined,
			[A],
			{ id: A }
		])
			expect({ no: String(no), id: parseRoleId(no) }).toEqual({ no: String(no), id: null });
	});

	test('the mention is built from the number alone', () => {
		expect(roleMention(A)).toBe(`<@&${A}>`);
		for (const no of [
			'',
			'everyone',
			'@everyone',
			'123',
			`${A}> @everyone`,
			'<@&1>',
			'9223372036854775808',
			'12345678901234567890'
		])
			expect(roleMention(no)).toBe('');
	});
});

describe('several roles', () => {
	test('in one text with spaces, commas or new lines between, or as a list: each once, in order', () => {
		expect(parseRoleIds(`${B} ${A}`)).toEqual([B, A]);
		expect(parseRoleIds(` ${A},${B}\n<@&${C}> `)).toEqual([A, B, C]);
		expect(parseRoleIds(`<@&${A}><@&${B}>`)).toEqual([A, B]);
		expect(parseRoleIds(`${A} <@&${A}> ${B} ${A}`)).toEqual([A, B]);
		expect(parseRoleIds([B, `<@&${A}>`, B])).toEqual([B, A]);
		// none is none, and says so as an empty list
		expect(parseRoleIds('')).toEqual([]);
		expect(parseRoleIds(' , \n')).toEqual([]);
		expect(parseRoleIds([])).toEqual([]);
		// how many is not this function's to say
		const many = Array.from({ length: 12 }, (_, i) => `1234567890123456${10 + i}`);
		expect(parseRoleIds(many)?.length).toBe(12);
	});

	test('one part that is no role refuses the lot', () => {
		for (const no of [
			`${A} Staff`,
			`${A} @everyone`,
			`${A}, <@${B}>`,
			`${A} 1234`,
			`${A}${B}`,
			`${A};${B}`,
			`<@&${A}>@everyone`,
			[A, 'everyone'],
			[A, 7],
			[A, null],
			[A, [B]],
			[A, ''],
			7,
			123456789012345678,
			null,
			undefined,
			{ 0: A, length: 1 },
			true
		])
			expect({ no: JSON.stringify(no), ids: parseRoleIds(no) }).toEqual({
				no: JSON.stringify(no),
				ids: null
			});
	});

	test('of a stored list, the role IDs are pinged and nothing else in it, each once, five at most', () => {
		expect(rolesToPing([A, B])).toEqual([A, B]);
		expect(rolesToPing([A, 'everyone', B, `<@&${C}>`, 7, null, A, '@here'])).toEqual([A, B]);
		for (const none of [null, undefined, '', A, `${A} ${B}`, { 0: A }, 7, []])
			expect(rolesToPing(none)).toEqual([]);
		const many = Array.from({ length: 12 }, (_, i) => `1234567890123456${10 + i}`);
		expect(MAX_STAFF_ROLES).toBe(5);
		expect(rolesToPing(many)).toEqual(many.slice(0, 5));
	});
});
