import { describe, expect, test } from 'bun:test';
import { eventFeedLines, eventFeedUrl, usesEventFeed } from './feed-setup';
import { parseIni } from './config-doc';

describe('kill feed setup', () => {
	test('a build whose RCON block allows EventFeedEndpoints takes the pasted lines', () => {
		const rcon = {
			section: '/Script/WDRCON.WDRCONSettings',
			appliesWhen: 'next-restart',
			allowedKeys: ['bEnabled', 'bEventFeedEnabled', 'EventFeedEndpoints', 'Password', 'Port']
		};
		expect(usesEventFeed([rcon])).toBe(true);
		expect(usesEventFeed([{ ...rcon, allowedKeys: ['bEnabled', 'Password', 'Port'] }])).toBe(false);
		expect(usesEventFeed(null)).toBe(false);
	});
	test('the lines switch the feed on, name this panel with its token, and name the server', () => {
		const lines = eventFeedLines('https://console.example', 'wkf_abc', '[EU] "Night" #1');
		expect(lines).toBe(
			[
				'bEventFeedEnabled=True',
				'+EventFeedEndpoints=(Url="https://console.example/api/ingest/events",Token="wkf_abc")',
				'EventFeedServerName="[EU] Night #1"'
			].join('\n')
		);
		const doc = parseIni(`[/Script/WDRCON.WDRCONSettings]\n${lines}\n`);
		expect(doc.warnings).toEqual([]);
		expect(doc.sections[0].keys.map((k) => k.key)).toEqual([
			'bEventFeedEnabled',
			'EventFeedEndpoints',
			'EventFeedServerName'
		]);
	});
	test('the Url names the ingest route: Season 2 posts to it as written', () => {
		expect(eventFeedUrl('https://console.example')).toBe(
			'https://console.example/api/ingest/events'
		);
		expect(eventFeedUrl('https://console.example/')).toBe(
			'https://console.example/api/ingest/events'
		);
	});
});
