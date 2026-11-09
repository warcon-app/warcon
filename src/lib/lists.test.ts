import { describe, expect, test } from 'bun:test';
import { describeSync } from './lists';
import type { ListSyncServer } from './types';

const server = (serverName: string, over: Partial<ListSyncServer> = {}): ListSyncServer => ({
	serverId: `s_${serverName.toLowerCase()}`,
	serverName,
	ok: true,
	added: 1,
	removed: 0,
	failed: 0,
	pending: false,
	error: '',
	...over
});

describe('describeSync', () => {
	test('no servers: they pick it up on the next poll', () => {
		expect(describeSync({ servers: [] }, 'Banned.')).toBe(
			'Banned. Servers pick it up on the next poll.'
		);
	});

	test('applied everywhere', () => {
		expect(describeSync({ servers: [server('Alpha'), server('Bravo')] }, 'Banned.')).toBe(
			'Banned. Applied on 2 of 2 servers.'
		);
	});

	test('each server that did not sync is named with its phrase, not as unreachable', () => {
		const text = describeSync(
			{
				servers: [
					server('Alpha'),
					server('Bravo', { ok: false, error: 'The server refused the RCON password.' }),
					server('Charlie', { ok: false, error: 'Could not reach the server.' }),
					server('Delta', { ok: false, error: 'The server refused the RCON password.' })
				]
			},
			'Reserved a slot.'
		);
		expect(text).toBe(
			'Reserved a slot. Applied on 1 of 4 servers.' +
				' Not synced on Bravo, Delta: The server refused the RCON password.' +
				' Not synced on Charlie: Could not reach the server.'
		);
		expect(text).not.toContain('Unreachable');
	});

	test('a run the server stopped answering part-way did not land', () => {
		expect(
			describeSync(
				{ servers: [server('Alpha', { error: 'The server failed to answer.' })] },
				'Sync ran.'
			)
		).toBe('Sync ran. Applied on 0 of 1 server. Not synced on Alpha: The server failed to answer.');
	});

	test('still syncing, refused entries, and a failure with no phrase', () => {
		expect(
			describeSync(
				{
					servers: [
						server('Alpha', { ok: false, pending: true, error: 'Sync already running.' }),
						server('Bravo', { failed: 2 }),
						server('Charlie', { ok: false })
					]
				},
				'Banned.'
			)
		).toBe(
			'Banned. Applied on 0 of 3 servers. Still syncing: Alpha.' +
				' Not synced on Charlie: The sync failed. Refused by: Bravo (see the list page).'
		);
	});
});
