import { describe, expect, test } from 'bun:test';
import {
	canonical,
	ORG_STATS_PLACEHOLDERS,
	PLAYER_PLACEHOLDERS,
	placeholdersFor,
	SERVER_PLACEHOLDERS,
	statsIn,
	STATS_PLACEHOLDERS,
	unfilled,
	usesStats
} from './placeholders';

describe('placeholdersFor', () => {
	test('a message to a player offers the rule’s own, the player, their stats here and across the org, and the server', () => {
		expect(placeholdersFor('team_kill')).toEqual([
			{ key: 'own', names: ['victim', 'count'] },
			{ key: 'player', names: [...PLAYER_PLACEHOLDERS] },
			{ key: 'stats', names: [...STATS_PLACEHOLDERS] },
			{ key: 'org', names: [...ORG_STATS_PLACEHOLDERS] },
			{ key: 'server', names: [...SERVER_PLACEHOLDERS] }
		]);
		expect(placeholdersFor('welcome').map((g) => g.key)).toEqual([
			'player',
			'stats',
			'org',
			'server'
		]);
	});
	test('a text kept where staff read it (a Kill distance reason can be a ban reason) has no org-wide stats', () => {
		expect(placeholdersFor('kill_distance').map((g) => g.key)).toEqual([
			'own',
			'player',
			'stats',
			'server'
		]);
		expect(unfilled(['{org_kills} {ORG_KDR} {kills}'], 'kill_distance')).toEqual([
			'{org_kills}',
			'{ORG_KDR}'
		]);
	});
	test('the organisation’s names are this server’s behind org_', () => {
		expect<string[]>([...ORG_STATS_PLACEHOLDERS]).toEqual(
			STATS_PLACEHOLDERS.map((n) => `org_${n}`)
		);
	});
	test('a message to everyone has no player; a name the rule fills itself is offered once, as its own', () => {
		expect(placeholdersFor('broadcast')).toEqual([
			{ key: 'server', names: [...SERVER_PLACEHOLDERS] }
		]);
		const match = placeholdersFor('match_broadcast');
		expect(match.map((g) => g.key)).toEqual(['own', 'server']);
		expect(match[0].names).toContain('scores');
		expect(match[1].names).not.toContain('scores');
	});
	test('a rule without a message offers nothing', () => {
		expect(placeholdersFor('empty_reset')).toEqual([]);
		expect(placeholdersFor('kill_rate')).toEqual([]);
	});
	test('Map vote offers weather in its messages', () => {
		expect(placeholdersFor('map_vote').find((group) => group.key === 'own')?.names).toContain(
			'weather'
		);
		expect(unfilled(['{WEATHER}'], 'map_vote')).toEqual([]);
	});
});

describe('the names a placeholder is typed with', () => {
	test('any case, and {player} and {kdr} for {name} and {kd}', () => {
		expect(canonical('KDR')).toBe('kd');
		expect(canonical('Player')).toBe('name');
		expect(canonical('Kills')).toBe('kills');
		expect(canonical('constructor')).toBe('constructor');
		expect(canonical('__proto__')).toBe('__proto__');
	});
	test('what a rule does not fill is listed as typed, each once', () => {
		expect(unfilled(['Welcome {player}: {Kills} kills, K/D {KDR}, on {map}'], 'welcome')).toEqual(
			[]
		);
		expect(unfilled(['{name} {kdrr} {KDRR} {victim}'], 'welcome')).toEqual(['{kdrr}', '{victim}']);
		expect(unfilled(['{name} has {kills}'], 'broadcast')).toEqual(['{name}', '{kills}']);
		expect(unfilled(['{victim}', 'Kicked: {why}'], 'team_kill')).toEqual(['{why}']);
		// what is not a placeholder at all is no concern of this
		expect(unfilled(['{ name } {1} {}'], 'welcome')).toEqual([]);
	});
});

describe('stats', () => {
	test('a text uses them through any of their names, this server’s and the organisation’s apart', () => {
		expect(usesStats('your KDR is {KDR}')).toBe(true);
		expect(usesStats('{playtime} on the server')).toBe(true);
		expect(usesStats('{Org_Kills} in all')).toBe(true);
		expect(usesStats('Welcome {name} to {server}')).toBe(false);
		expect(usesStats('kills')).toBe(false);
		expect(statsIn('{kills} here')).toEqual({ here: true, org: false });
		expect(statsIn('{org_kdr} in all')).toEqual({ here: false, org: true });
		expect(statsIn('{kd} and {org_kd}')).toEqual({ here: true, org: true });
		expect(statsIn('{org} {orgkills}')).toEqual({ here: false, org: false });
	});
});
