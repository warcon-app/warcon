import { describe, expect, test } from 'bun:test';
import { validateWebhookUrl } from './webhooks';
import { buildEmbed, classify } from './webhook-delivery';

const token = 'a'.repeat(68);

describe('validateWebhookUrl', () => {
	test('accepts Discord webhook URLs and hides the token in the hint', () => {
		const { url, hint } = validateWebhookUrl(
			`https://DISCORD.com/api/webhooks/123456789012345678/${token}?wait=true`
		);
		expect(url).toBe(`https://discord.com/api/webhooks/123456789012345678/${token}`);
		expect(hint).toBe('discord.com/api/webhooks/123456789012345678/…');
		expect(
			validateWebhookUrl(`https://ptb.discord.com/api/webhooks/123456789012345678/${token}`).url
		).toContain('ptb.discord.com');
	});
	test('refuses anything that is not a Discord webhook', () => {
		expect(() => validateWebhookUrl('not a url')).toThrow('not a URL');
		expect(() =>
			validateWebhookUrl(`http://discord.com/api/webhooks/123456789012345678/${token}`)
		).toThrow('Discord webhook URL');
		expect(() =>
			validateWebhookUrl(`https://example.com/api/webhooks/123456789012345678/${token}`)
		).toThrow('Discord webhook URL');
		expect(() => validateWebhookUrl('https://discord.com/api/channels/1/messages')).toThrow(
			'Discord webhook URL'
		);
		expect(() =>
			validateWebhookUrl('https://discord.com/api/webhooks/123456789012345678/short')
		).toThrow('Discord webhook URL');
	});
});

describe('classify', () => {
	test('routes rows to event classes', () => {
		expect(classify({ category: 'rcon', action: 'rcon.ban' })).toBe('bans');
		expect(classify({ category: 'rcon', action: 'rcon.kick' })).toBe('commands');
		expect(classify({ category: 'trigger', action: 'trigger.welcome' })).toBe('triggers');
		expect(classify({ category: 'player', action: 'player.note' })).toBe('players');
		expect(classify({ category: 'org', action: 'org.invite.create' })).toBe('management');
		expect(classify({ category: 'auth', action: 'login' })).toBe('auth');
		expect(classify({ category: 'weird', action: 'x' })).toBeNull();
	});
});

describe('buildEmbed', () => {
	const row = {
		id: 1,
		ts: new Date('2026-09-09T12:00:00Z'),
		actorId: 'u1',
		actorName: 'james',
		serverId: 's1',
		serverName: 'EU #1',
		orgId: 'o1',
		category: 'rcon',
		action: 'rcon.kick',
		target: '76561198000000001',
		detail: { reason: 'tk', password: 'x' },
		outcome: 'ok' as const,
		status: 200,
		message: 'Kicked Nomad.',
		ip: '203.0.113.9',
		userAgent: 'curl',
		durationMs: 12
	};
	test('names the action, actor, target and server, never the IP', () => {
		const e = buildEmbed('Warcon', row);
		expect(e.title).toBe('Kick');
		expect(e.description).toContain('**james** → `76561198000000001`');
		expect(e.description).toContain('Server: EU #1');
		expect(e.description).toContain('Kicked Nomad.');
		expect(JSON.stringify(e)).not.toContain('203.0.113.9');
		expect(e.color).toBe(0x7bc462);
		expect(e.timestamp).toBe('2026-09-09T12:00:00.000Z');
	});
	test('failures are red and say so', () => {
		const e = buildEmbed('Warcon', {
			...row,
			outcome: 'denied',
			status: 403,
			message: 'needs admin'
		});
		expect(e.description).toContain('Outcome: **denied** (403)');
		expect(e.color).toBe(0x8a8a90);
	});
});
