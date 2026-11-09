import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { nameFilterTargets, nameVerdict, validateNameFilter } from './name-filter';

const DICT = '/usr/share/dict/words';
const rule = (c: Record<string, unknown>) => validateNameFilter(c);
const verdict = (c: Record<string, unknown>, name: string) =>
	nameVerdict(rule(c), name)?.verdict ?? null;

describe('validateNameFilter', () => {
	test('needs a policy or a word list', () => {
		expect(() => rule({})).toThrow(/character policy/);
		expect(() => rule({ allowed: ['fine'] })).toThrow(/character policy/);
		expect(rule({ characters: 'ascii' }).characters).toBe('ascii');
	});
	test('defaults: kick, reserved spared, a reason with {why}', () => {
		const c = rule({ builtinWords: true });
		expect(c.action).toBe('kick');
		expect(c.spareReserved).toBe(true);
		expect(c.reason).toContain('{why}');
	});
	test('words are lowercased, deduplicated and taken from lines or commas', () => {
		expect(rule({ blocked: 'Nazi\nnazi, Heil Hitler\n\n' }).blocked).toEqual([
			'nazi',
			'heil hitler'
		]);
	});
	test('a word is letters, digits and spaces: no patterns', () => {
		expect(() => rule({ blocked: ['(a+)+$'] })).toThrow(/letters, digits or spaces/);
		expect(() => rule({ blocked: ['x'] })).toThrow(/2-40/);
		expect(() => rule({ blocked: Array.from({ length: 201 }, (_, i) => `word${i}`) })).toThrow(
			/200 at most/
		);
	});
	test('players it never acts on are SteamID64 strings, each once, 100 at most', () => {
		expect(rule({ builtinWords: true }).exempt).toEqual([]);
		expect(
			rule({ blocked: ['nobs'], exempt: [' 76561198000000001', '76561198000000001', ''] }).exempt
		).toEqual(['76561198000000001']);
		expect(() => rule({ blocked: ['nobs'], exempt: ['Ramon'] })).toThrow(
			'"Ramon" is not a SteamID64'
		);
		expect(() => rule({ blocked: ['nobs'], exempt: '76561198000000001' })).toThrow(
			'exempt must be a list'
		);
		// a JSON number that long arrives rounded, and would leave another player alone
		expect(() => rule({ blocked: ['nobs'], exempt: JSON.parse('[76561198100000101]') })).toThrow(
			'sent as strings'
		);
		const many = Array.from({ length: 101 }, (_, i) => String(76561198000000000n + BigInt(i)));
		expect(() => rule({ blocked: ['nobs'], exempt: many })).toThrow('At most 100');
	});
	test('extra scripts only count with the Latin policy, and only known ones', () => {
		expect(
			rule({ characters: 'latin', extraScripts: ['Cyrillic', 'Klingon'] }).extraScripts
		).toEqual(['Cyrillic']);
		expect(rule({ characters: 'ascii', extraScripts: ['Cyrillic'] }).extraScripts).toEqual([]);
	});
});

describe('character policy', () => {
	test('ascii keeps what a US keyboard types', () => {
		const c = { characters: 'ascii' };
		expect(verdict(c, 'xX_Sn1per-99_Xx [BHPH]')).toBeNull();
		expect(verdict(c, 'José')).toMatch(/ASCII policy \(é\)/);
		expect(verdict(c, 'Иван')).toMatch(/ASCII/);
		expect(verdict(c, 'ＦＵＬＬ')).toMatch(/ASCII/);
	});
	test('latin keeps accents and refuses other alphabets', () => {
		const c = { characters: 'latin' };
		expect(verdict(c, 'José Müller')).toBeNull();
		expect(verdict(c, 'Jose\u0301')).toBeNull(); // a decomposed é is still é
		expect(verdict(c, 'Иван')).toMatch(/Latin policy \(И в а н\)/);
		expect(verdict(c, '死神')).toMatch(/Latin/);
		expect(verdict(c, '𝕱𝖆𝖓𝖈𝖞')).toMatch(/Latin/);
	});
	test('an extra script is let in beside Latin', () => {
		const c = { characters: 'latin', extraScripts: ['Cyrillic'] };
		expect(verdict(c, 'Иван')).toBeNull();
		expect(verdict(c, '死神')).toMatch(/Latin/);
	});
	test('emoji and symbols pass only when allowed', () => {
		expect(verdict({ characters: 'ascii' }, '🐺psychonurse')).toMatch(/ASCII policy \(🐺\)/);
		expect(verdict({ characters: 'ascii', allowSymbols: true }, '🐺psycho【BHPH】★')).toBeNull();
		expect(verdict({ characters: 'ascii', allowSymbols: true }, 'Иван★')).toMatch(/ASCII/);
	});
	test('a name needs its letters', () => {
		expect(verdict({ minLetters: 3 }, '____')).toBe('0 letters (minimum 3)');
		expect(verdict({ minLetters: 3 }, 'a1')).toBe('1 letter (minimum 3)');
		expect(verdict({ minLetters: 3 }, 'abc')).toBeNull();
	});
});

describe('nameFilterTargets', () => {
	const joined = [
		{ steamId: '1', name: 'Иван' },
		{ steamId: '2', name: 'Ivan' },
		{ steamId: '3', name: 'Пётр' }
	];
	test('a reserved slot is spared unless the rule says otherwise', () => {
		const spared = nameFilterTargets(rule({ characters: 'latin' }), joined, new Set(['3']));
		expect(spared.map((t) => t.player.steamId)).toEqual(['1']);
		const all = nameFilterTargets(
			rule({ characters: 'latin', spareReserved: false }),
			joined,
			new Set(['3'])
		);
		expect(all.map((t) => t.player.steamId)).toEqual(['1', '3']);
	});
	test('a player on its own list is never acted on, and the list needs no reserved slot', () => {
		const STAFF = '76561198000000001';
		const tag = rule({ blocked: ['nobs'], spareReserved: false, exempt: [STAFF] });
		const on = [
			{ steamId: STAFF, name: '[NoBS] Ramon' },
			{ steamId: '76561198000000002', name: '[N0B$] Ramon' },
			{ steamId: '76561198000000003', name: 'Plain' }
		];
		const ids = (reserved: string[]) =>
			nameFilterTargets(tag, on, new Set(reserved)).map((t) => t.player.steamId);
		expect(ids([])).toEqual(['76561198000000002']);
		// reserved slots not spared: a slot is no licence to wear the tag
		expect(ids(['76561198000000002'])).toEqual(['76561198000000002']);
	});
});

describe('words', () => {
	const c = { blocked: ['nazi', 'hitler', 'kkk', '1488', 'хуй'], allowed: ['nazira'] };
	test('sees through case, leetspeak, look-alikes, stretching and spelling out', () => {
		for (const n of ['xX_NAZI_Xx', 'n4z1', 'n.a.z.i', 'N A Z I', 'naaaazi', 'h1tl3r', 'nаzi'])
			expect(verdict(c, n)).toMatch(/blocked word '(nazi|hitler)'/);
	});
	test('doubled letters, digits, accents and other alphabets get the same treatment', () => {
		expect(verdict(c, 'KKK_grand')).toBe("blocked word 'kkk'");
		expect(verdict(c, 'kkkkkk')).toBe("blocked word 'kkk'");
		expect(verdict(c, 'Jokker')).toBeNull(); // two k, the word has three
		expect(verdict(c, 'pro1488')).toBe("blocked word '1488'");
		expect(verdict(c, 'Diablo')).toBeNull(); // a digit in a word is a digit, never leetspeak
		expect(verdict(c, 'ХУЙло')).toBe("blocked word 'хуй'");
		expect(verdict(c, 'xyйло')).toBe("blocked word 'хуй'"); // Latin x and y for the Cyrillic
		expect(verdict({ blocked: ['fötze'] }, 'F0TZE')).toBe("blocked word 'fötze'");
		expect(verdict({ blocked: ['fotze'] }, 'Fötze')).toBe("blocked word 'fotze'");
		expect(verdict({ blocked: ['gilipollas'] }, 'g1l1p0llas')).toBe("blocked word 'gilipollas'");
	});
	test('a phrase matches with its words apart or run together', () => {
		const p = { blocked: ['white power'] };
		expect(verdict(p, 'White_Power')).toBe("blocked word 'white power'");
		expect(verdict(p, 'whitepower88')).toBe("blocked word 'white power'");
		expect(verdict(p, 'White Tower')).toBeNull();
	});
	test('a clan tag is a word: brackets, leetspeak and spacing do not hide it', () => {
		const t = { blocked: ['nobs'] };
		for (const n of ['[NoBS] Ramon', '[N0B$]Ramon', '{N o B S} x', 'Ramon NOBS', '(nobs)'])
			expect(verdict(t, n)).toBe("blocked word 'nobs'");
		// found inside other words too, which is what the exceptions are for
		expect(verdict(t, 'Knobs')).toBe("blocked word 'nobs'");
		expect(verdict({ ...t, allowed: ['knobs'] }, 'Knobs')).toBeNull();
	});
	test('the admin exception wins', () => {
		expect(verdict(c, 'Nazira')).toBeNull();
		expect(verdict(c, 'NAZIRA_99')).toBeNull();
		expect(verdict({ blocked: ['1488'], allowed: ['x1488x'] }, 'x1488x')).toBeNull();
	});
	test('the built-in list is slurs and hate terms, with their exceptions', () => {
		const b = { builtinWords: true };
		for (const n of ['n1gg3r', 'NIGGAAA', 'f4gg0t', 'r4p1st', 'H1tler', 'Sieg_Heil', 'p3d0bear'])
			expect([n, verdict(b, n)]).toEqual([n, expect.stringMatching(/^blocked word/)]);
		for (const n of [
			'Grape Ape',
			'Therapist',
			'Raccoon',
			'Tycoon',
			'Pakistan Zindabad',
			'Spicy Boi',
			'Torpedo',
			'Dick Van Dyke',
			'MC Rapper',
			'Wrapped',
			'The Whittler',
			'Nazir Khan',
			'Ashkenazi',
			'Sniggering',
			'Aspic',
			'Leafage',
			'Speedo',
			'Scunthorpe',
			'Assassin',
			'NoFucksGiven',
			'kkkkkk',
			'psychonurse [BHPH]'
		])
			expect([n, verdict(b, n)]).toEqual([n, null]);
	});
	// Stretching and leetspeak must not reach into ordinary words: whatever the list finds in the
	// dictionary has the word in it as written.
	test.skipIf(!existsSync(DICT))('the built-in list against the system dictionary', () => {
		const cfg = rule({ builtinWords: true });
		const surprises = readFileSync(DICT, 'utf8')
			.split('\n')
			.filter((w) => {
				const word = nameVerdict(cfg, w)?.verdict.match(/'(.+)'/)?.[1];
				return word && !w.toLowerCase().includes(word);
			});
		// l reads as i, so this spelling of the listed word is found too; it is no innocent word
		expect(surprises).toEqual(['Mongolioid']);
	});
	test('every mock joiner and demo player passes the built-in list', () => {
		for (const n of ['Copperhead', 'Late_to_the_party', 'VelvetThunder', 'Brick', 'Saltmine'])
			expect(verdict({ builtinWords: true }, n)).toBeNull();
	});
	test('separate words are not run together', () => {
		expect(verdict({ blocked: ['ashit'] }, 'Bas Hit')).toBeNull();
	});
	test('the player is told the kind of fault, never the word', () => {
		const v = nameVerdict(rule(c), 'nazi')!;
		expect(v.why).not.toContain('nazi');
	});
	// "1" and "|" stand for i and for l: were both readings kept, "ilililil" against a run of ones
	// would try every way of sharing them out.
	test('no word and name can make a pattern backtrack', () => {
		// each ends in a letter the names lack: a pattern that cannot match tries every split
		const words = ['ililililililq', 'li li li li li li liq', 'a a a a a a a a aq', 'szszszszq'];
		const t = performance.now();
		for (const name of ['1'.repeat(100), '|'.repeat(99) + 'x', 'a '.repeat(50), '5'.repeat(100)])
			nameVerdict(rule({ blocked: words }), name);
		expect(performance.now() - t).toBeLessThan(100);
	});
	test('b1ack reads as black, and h1t1er as hitler', () => {
		expect(verdict({ blocked: ['black'] }, 'B1ACK_ops')).toBe("blocked word 'black'");
		expect(verdict({ blocked: ['hitler'] }, 'h1t1er')).toBe("blocked word 'hitler'");
		expect(verdict({ blocked: ['hitler'] }, 'H|TLER')).toBe("blocked word 'hitler'");
	});
	test('a hostile name does not hang the matcher', () => {
		const t = performance.now();
		nameVerdict(rule({ builtinWords: true, blocked: ['nazi'] }), 'a.'.repeat(5000) + '!');
		expect(performance.now() - t).toBeLessThan(250);
	});
});
