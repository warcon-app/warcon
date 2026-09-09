import { describe, expect, test } from 'bun:test';
import { ApiError } from './http';
import { assertReachableTarget, classifyAddress, gamePath, normaliseHost } from './hostpolicy';

describe('classifyAddress', () => {
	test('IPv4 ranges', () => {
		expect(classifyAddress('8.8.8.8')).toBe('public');
		expect(classifyAddress('2.28.114.105')).toBe('public');
		expect(classifyAddress('127.0.0.1')).toBe('private');
		expect(classifyAddress('127.9.9.9')).toBe('private');
		expect(classifyAddress('0.0.0.0')).toBe('private');
		expect(classifyAddress('10.1.2.3')).toBe('private');
		expect(classifyAddress('172.16.0.1')).toBe('private');
		expect(classifyAddress('172.31.255.255')).toBe('private');
		expect(classifyAddress('172.32.0.1')).toBe('public');
		expect(classifyAddress('192.168.1.1')).toBe('private');
		expect(classifyAddress('100.64.0.1')).toBe('private');
		expect(classifyAddress('100.128.0.1')).toBe('public');
		expect(classifyAddress('169.254.169.254')).toBe('linklocal');
		expect(classifyAddress('224.0.0.1')).toBe('private');
		expect(classifyAddress('255.255.255.255')).toBe('private');
		expect(classifyAddress('198.18.0.1')).toBe('private');
		expect(classifyAddress('203.0.113.7')).toBe('private');
	});

	test('IPv6 ranges, including addresses that wrap IPv4', () => {
		expect(classifyAddress('2a01:4f8::1')).toBe('public');
		expect(classifyAddress('::1')).toBe('private');
		expect(classifyAddress('::')).toBe('private');
		expect(classifyAddress('[::1]')).toBe('private');
		expect(classifyAddress('fe80::1%eth0')).toBe('linklocal');
		expect(classifyAddress('febf::1')).toBe('linklocal');
		expect(classifyAddress('fc00::1')).toBe('private');
		expect(classifyAddress('fd12:3456::1')).toBe('private');
		expect(classifyAddress('ff02::1')).toBe('private');
		expect(classifyAddress('2001:db8::1')).toBe('private');
		expect(classifyAddress('::ffff:127.0.0.1')).toBe('private');
		expect(classifyAddress('::ffff:169.254.169.254')).toBe('linklocal');
		expect(classifyAddress('::ffff:8.8.8.8')).toBe('public');
		expect(classifyAddress('::ffff:7f00:1')).toBe('private');
		expect(classifyAddress('64:ff9b::a9fe:a9fe')).toBe('linklocal');
		expect(classifyAddress('64:ff9b::808:808')).toBe('public');
	});

	test('rejects things that are not addresses', () => {
		expect(classifyAddress('example.com')).toBeNull();
		expect(classifyAddress('1.2.3')).toBeNull();
		expect(classifyAddress('1.2.3.256')).toBeNull();
		expect(classifyAddress(':::1')).toBeNull();
		expect(classifyAddress('1:2:3:4:5:6:7:8:9')).toBeNull();
		expect(classifyAddress('')).toBeNull();
	});
});

describe('normaliseHost', () => {
	test('hostnames and IPv4 pass through lowercased', () => {
		expect(normaliseHost(' Game1.Example.com ')).toBe('game1.example.com');
		expect(normaliseHost('2.28.114.105')).toBe('2.28.114.105');
	});

	test('IPv6 literals come out bracketed', () => {
		expect(normaliseHost('::1')).toBe('[::1]');
		expect(normaliseHost('[2a01:4f8::1]')).toBe('[2a01:4f8::1]');
	});

	test('refuses embedded ports, schemes and junk', () => {
		for (const bad of ['host:7776', 'http://x', 'a b', '-x.com', 'x..y', '[nope]', 'x/y', ''])
			expect(() => normaliseHost(bad)).toThrow(ApiError);
	});
});

describe('assertReachableTarget', () => {
	test('org owners get public literals only', async () => {
		await expect(assertReachableTarget('8.8.8.8', false)).resolves.toEqual([
			{ address: '8.8.8.8', kind: 'public' }
		]);
		await expect(assertReachableTarget('127.0.0.1', false)).rejects.toMatchObject({
			status: 403,
			code: 'blocked_host'
		});
		await expect(assertReachableTarget('10.0.0.5', false)).rejects.toThrow(/private address/);
		await expect(assertReachableTarget('[::ffff:10.0.0.5]', false)).rejects.toThrow(
			/private address/
		);
	});

	test('the site owner may use private addresses but never link-local', async () => {
		await expect(assertReachableTarget('127.0.0.1', true)).resolves.toHaveLength(1);
		await expect(assertReachableTarget('192.168.0.10', true)).resolves.toHaveLength(1);
		await expect(assertReachableTarget('169.254.169.254', true)).rejects.toThrow(/link-local/);
		await expect(assertReachableTarget('169.254.169.254', false)).rejects.toThrow(/link-local/);
	});

	test('hostnames are resolved before they are judged', async () => {
		await expect(assertReachableTarget('localhost', false)).rejects.toMatchObject({
			code: 'blocked_host'
		});
		await expect(assertReachableTarget('localhost', true)).resolves.toBeTruthy();
		await expect(
			assertReachableTarget('definitely-not-a-real-host.invalid', true)
		).rejects.toMatchObject({ code: 'unresolvable' });
	});
});

describe('gamePath', () => {
	test('keeps ordinary /v1 paths and their query', () => {
		expect(gamePath('/v1/status')).toBe('/v1/status');
		expect(gamePath('/v1/config?force=true')).toBe('/v1/config?force=true');
		expect(gamePath('/v1/players/7656/kill')).toBe('/v1/players/7656/kill');
	});

	test('refuses anything that would leave /v1/ once a URL parser reads it', () => {
		for (const bad of [
			'/v1/../hetzner/v1/metadata',
			'/v1/%2e%2e/hetzner/v1/metadata',
			'/v1/x/%2E%2E/%2E%2E/latest/meta-data',
			'/v1/.%2e/x',
			'v1/status',
			'/v2/status',
			'/v1',
			'//evil.example/v1/x',
			'http://evil.example/v1/x',
			'/v1/x#/../y',
			''
		])
			expect(() => gamePath(bad), bad).toThrow(ApiError);
	});
});
