import { describe, expect, test } from 'bun:test';
import { currentState, matchStateOf, stateLabel } from './match-state';

describe('stateLabel', () => {
	test('every state posted so far has a name', () => {
		expect(
			[
				'MatchState.PreMatch',
				'MatchState.PreMatch.WaitingForWorldLoad',
				'MatchState.PreMatch.WaitingForPlayers',
				'MatchState.PreMatch.WaitingForPlayers.PlayerCount',
				'MatchState.Playing',
				'MatchState.Playing.KOTH',
				'MatchState.PostMatch'
			].map(stateLabel)
		).toEqual([
			'Pre-match',
			'Loading the map',
			'Waiting for players',
			'Waiting for enough players',
			'Playing',
			'Playing',
			'Match over'
		]);
	});

	test('a sub-state not known yet takes its parent name; anything else is shown as sent', () => {
		expect(stateLabel('MatchState.Playing.Overtime')).toBe('Playing');
		expect(stateLabel('MatchState.PostMatch.Voting')).toBe('Match over');
		expect(stateLabel('MatchState.Paused')).toBe('Paused');
		// a prefix of a name is not that name
		expect(stateLabel('MatchState.PlayingField')).toBe('PlayingField');
	});
});

describe('currentState', () => {
	const state = { state: 'MatchState.Playing.KOTH', map: 'Kavkazi', at: '2026-10-15T12:00:00Z' };
	test('the last state while the server answers', () => {
		expect(currentState({ ok: true, startedAt: '2026-10-15T08:42:00Z', matchState: state })).toBe(
			state
		);
		expect(currentState({ ok: true, startedAt: null, matchState: state })).toBe(state);
		expect(currentState({ ok: false, startedAt: null, matchState: state })).toBeNull();
		expect(currentState({ ok: true, startedAt: null, matchState: null })).toBeNull();
		expect(currentState({ ok: true, startedAt: null })).toBeNull();
		expect(currentState(null)).toBeNull();
	});

	test('a state from before the game last started is gone; the start is read a little either way', () => {
		const at = (iso: string) => ({ ok: true, startedAt: iso, matchState: state });
		expect(currentState(at('2026-10-15T12:30:00Z'))).toBeNull();
		expect(currentState(at('2026-10-15T12:01:30Z'))).toBeNull();
		expect(currentState(at('2026-10-15T12:00:30Z'))).toBe(state);
	});
});

describe('matchStateOf', () => {
	test('keeps the shape the panel reads, refuses the rest', () => {
		const state = { state: 'MatchState.PostMatch', map: 'Europe', at: '2026-10-15T12:00:00Z' };
		expect(matchStateOf({ ...state, extra: 1 })).toEqual(state);
		expect(matchStateOf(null)).toBeNull();
		expect(matchStateOf('MatchState.PostMatch')).toBeNull();
		expect(matchStateOf({ ...state, at: 'yesterday' })).toBeNull();
		expect(matchStateOf({ ...state, state: 7 })).toBeNull();
		expect(matchStateOf({ state: state.state, at: state.at })).toBeNull();
	});
});
