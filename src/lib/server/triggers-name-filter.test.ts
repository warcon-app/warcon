import { describe, expect, test } from 'bun:test';
import { evaluateTriggers, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';
import { validateNameFilter } from './name-filter';
import type { Env } from './env';
import type { Player } from '$lib/types';

const player = (steamId: string, name: string): Player => ({
	name,
	steamId,
	faction: null,
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: null
});
const row = (config: Record<string, unknown>) =>
	({
		id: 'rule',
		kind: 'name_filter',
		config: validateNameFilter(config)
	}) as unknown as TriggerRow;
const tick = (
	joined: Player[],
	renamed: Player[],
	reserved: string[] = [],
	returned: Player[] = []
) =>
	({
		server: { id: 'srv', name: 'Server' },
		status: { players: joined.length + renamed.length, maxPlayers: 64 },
		players: [...joined, ...renamed, ...returned],
		joined,
		renamed,
		returned,
		riskCheck: [],
		factioned: [],
		firstVisit: new Set(),
		reserved: new Set(reserved),
		reservedLoaded: true,
		ts: new Date(0)
	}) as unknown as TickContext;
const run = (config: Record<string, unknown>, ctx: TickContext) =>
	evaluateTriggers({} as Env, ctx, [row(config)]);

describe('the name filter rule', () => {
	test('judges a name that arrives after the join: a clan tag shown a look later', async () => {
		const ev = await run(
			{ blocked: ['tag'] },
			tick([player('1', 'Joiner')], [player('2', '[TAG] Player'), player('3', '[GG] Fine')])
		);
		expect(ev.intents.map((i) => [i.action, i.target])).toEqual([['kick', '2']]);
		expect(ev.intents[0].detail).toEqual({ name: '[TAG] Player', verdict: "blocked word 'tag'" });
	});
	test('still judges joiners, and spares a reserved slot on a rename too', async () => {
		const ev = await run(
			{ blocked: ['tag'] },
			tick([player('1', '[TAG] Joiner')], [player('2', '[TAG] Player')], ['2'])
		);
		expect(ev.intents.map((i) => i.target)).toEqual(['1']);
	});
	test('a kicked player back inside the leave grace is judged again, not taken as the same stay', async () => {
		const ev = await run(
			{ blocked: ['tag'] },
			tick([], [], [], [player('4', '[TAG] Again'), player('5', 'Fine')])
		);
		expect(ev.intents.map((i) => [i.action, i.target])).toEqual([['kick', '4']]);
	});
	test('an alert-only rule does not alert again for everyone back after a map change', async () => {
		const ev = await run(
			{ blocked: ['tag'], action: 'alert' },
			tick([], [], [], [player('4', '[TAG] Again')])
		);
		expect(ev).toEqual({ intents: [], updates: [] });
	});
	test('a player on its own list is left alone however the name arrives, kick or alert', async () => {
		const [joiner, renamer, back] = ['76561198000000001', '76561198000000002', '76561198000000003'];
		for (const action of ['kick', 'alert']) {
			const ev = await run(
				{ blocked: ['nobs'], spareReserved: false, exempt: [joiner, renamer, back], action },
				tick(
					[player(joiner, '[NoBS] Ramon'), player('4', '[NoBS] Fake')],
					[player(renamer, '[N0BS] Staff')],
					[],
					[player(back, '[NoBS] Again')]
				)
			);
			expect(ev.intents.map((i) => [i.action, i.target])).toEqual([
				[action === 'kick' ? 'kick' : 'name_flag', '4']
			]);
		}
	});
	test('sparing reserved slots, it acts on nobody until the list is read, and says so', async () => {
		const unread = {
			...tick([player('1', '[TAG] Joiner')], [player('2', '[TAG] Slot')]),
			reservedLoaded: false
		};
		const ev = await run({ blocked: ['tag'] }, unread);
		expect(ev).toEqual({
			intents: [],
			updates: [{ id: 'rule', lastResult: 'Waiting for the reserved slots to be read' }]
		});
		// a rule that spares none needs no list
		const all = await run({ blocked: ['tag'], spareReserved: false }, unread);
		expect(all.intents.map((i) => i.target)).toEqual(['1', '2']);
	});
	test('a look with no joiner and no new name does nothing', async () => {
		const ev = await run({ blocked: ['tag'] }, tick([], []));
		expect(ev).toEqual({ intents: [], updates: [] });
	});
});
