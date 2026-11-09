import { describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { ACTIONS } from '$lib/server/actions';
import { setMockFeed } from '$lib/server/mockgame';
import { WardogsClient } from '$lib/server/rcon';
import { feedDiagnosis, feedReportOf, isPanel, type FeedEndpoint } from './feed-report';

const ORIGIN = 'https://console.warcon.app';

/** TLR #1's answer on 2026-10-18 (the second endpoint's host stands in for the real one). */
const TLR = {
	enabled: true,
	endpointCount: 2,
	anyUnhealthy: true,
	endpoints: [
		{
			index: 0,
			scheme: 'https',
			host: 'console.warcon.app',
			healthy: false,
			queued: 0,
			inFlight: 0,
			consecutiveFailures: 2,
			sentTotal: 0,
			droppedTotal: 4,
			lastHttpStatus: 405,
			lastSuccessUnixSeconds: null
		},
		{
			index: 1,
			scheme: 'https',
			host: 'other.example',
			healthy: true,
			queued: 0,
			inFlight: 0,
			consecutiveFailures: 0,
			sentTotal: 4,
			droppedTotal: 0,
			lastHttpStatus: 200,
			lastSuccessUnixSeconds: 1792310606
		}
	]
};

const started = '2026-10-18T08:00:00.000Z';
/** Warcon's endpoint in a report of one, with `over` on top. */
const ours = (over: Partial<Record<keyof FeedEndpoint | 'lastSuccessUnixSeconds', unknown>>) =>
	feedReportOf({
		enabled: true,
		endpointCount: 1,
		endpoints: [{ ...TLR.endpoints[0], ...over }]
	})!;

describe('feedReportOf', () => {
	test("keeps TLR #1's answer to the known fields", () => {
		expect(feedReportOf(TLR)).toEqual({
			enabled: true,
			endpointCount: 2,
			endpoints: [
				{
					index: 0,
					scheme: 'https',
					host: 'console.warcon.app',
					healthy: false,
					queued: 0,
					inFlight: 0,
					consecutiveFailures: 2,
					sentTotal: 0,
					droppedTotal: 4,
					lastHttpStatus: 405,
					lastSuccessAt: null
				},
				{
					index: 1,
					scheme: 'https',
					host: 'other.example',
					healthy: true,
					queued: 0,
					inFlight: 0,
					consecutiveFailures: 0,
					sentTotal: 4,
					droppedTotal: 0,
					lastHttpStatus: 200,
					lastSuccessAt: '2026-10-18T08:03:26.000Z'
				}
			]
		});
	});

	test('anything but a report is null', () => {
		for (const raw of [null, undefined, 'x', 42, [], {}, { enabled: 'true' }, { endpoints: [] }])
			expect(feedReportOf(raw)).toBeNull();
	});

	test('a feed that is off, and a list left out of the answer', () => {
		expect(feedReportOf({ enabled: false, endpointCount: 0, endpoints: [] })).toEqual({
			enabled: false,
			endpointCount: 0,
			endpoints: []
		});
		// the console's reader allows `endpoints` to be absent
		expect(feedReportOf({ enabled: true, endpointCount: 2 })).toEqual({
			enabled: true,
			endpointCount: 2,
			endpoints: []
		});
	});

	test('odd values come out as nothing rather than as what they claim', () => {
		const r = ours({
			scheme: 'javascript',
			host: 'evil<script>.example/path?x=1',
			healthy: 'yes',
			sentTotal: -3,
			droppedTotal: 1.5,
			lastHttpStatus: 999,
			lastSuccessUnixSeconds: 'yesterday'
		});
		expect(r.endpoints[0]).toMatchObject({
			scheme: '',
			host: 'evilscript.examplepathx1',
			healthy: false,
			sentTotal: 0,
			droppedTotal: 0,
			lastHttpStatus: null,
			lastSuccessAt: null
		});
		const many = feedReportOf({ enabled: true, endpoints: Array(20).fill(TLR.endpoints[1]) })!;
		expect(many.endpoints).toHaveLength(8);
	});
});

describe('isPanel', () => {
	test('the origin host, with or without its port, in any case', () => {
		expect(isPanel({ host: 'console.warcon.app' }, ORIGIN)).toBe(true);
		expect(isPanel({ host: 'Console.Warcon.App' }, ORIGIN)).toBe(true);
		expect(isPanel({ host: 'warcon.app' }, ORIGIN)).toBe(false);
		expect(isPanel({ host: '203.0.113.9:5199' }, 'http://203.0.113.9:5199')).toBe(true);
		expect(isPanel({ host: '203.0.113.9' }, 'http://203.0.113.9:5199')).toBe(true);
		expect(isPanel({ host: '' }, ORIGIN)).toBe(false);
		expect(isPanel({ host: 'console.warcon.app' }, 'not a url')).toBe(false);
	});
});

describe('feedDiagnosis', () => {
	const diagnose = (r: ReturnType<typeof feedReportOf>, state = 'silent' as const) =>
		feedDiagnosis(r!, ORIGIN, state);

	test("TLR #1: Warcon's line names the site alone", () => {
		const d = diagnose(feedReportOf(TLR));
		expect([d.fault, d.endpoint?.index, d.others]).toEqual(['path', 0, 1]);
	});

	test('what the game answered tells which fault it is', () => {
		expect(diagnose(ours({ lastHttpStatus: 404 })).fault).toBe('path');
		expect(diagnose(ours({ lastHttpStatus: 401 })).fault).toBe('token');
		expect(diagnose(ours({ lastHttpStatus: 403 })).fault).toBe('forbidden');
		expect(diagnose(ours({ lastHttpStatus: 502 })).fault).toBe('panel');
		expect(diagnose(ours({ lastHttpStatus: 413 })).fault).toBe('refused');
		expect(diagnose(ours({ lastHttpStatus: null, consecutiveFailures: 3 })).fault).toBe(
			'unreachable'
		);
		// nothing tried yet
		expect(diagnose(ours({ lastHttpStatus: null, consecutiveFailures: 0 })).fault).toBeNull();
	});

	test('the feed off, empty or posting elsewhere', () => {
		expect(diagnose(feedReportOf({ enabled: false, endpointCount: 0 })).fault).toBe('off');
		expect(diagnose(feedReportOf({ enabled: true, endpointCount: 0 })).fault).toBe('empty');
		const elsewhere = diagnose(
			feedReportOf({ enabled: true, endpointCount: 1, endpoints: [TLR.endpoints[1]] })
		);
		expect([elsewhere.fault, elsewhere.others]).toEqual(['elsewhere', 1]);
	});

	test("sent here since the start while nothing came for this server: another server's token", () => {
		// the game's counters start again at its start; sent counts batches the panel took
		const sent = (sentTotal: number, lastSuccessUnixSeconds: number | null) =>
			ours({
				healthy: true,
				lastHttpStatus: 200,
				consecutiveFailures: 0,
				sentTotal,
				lastSuccessUnixSeconds
			});
		expect(diagnose(sent(2, null)).fault).toBe('otherToken');
		expect(diagnose(sent(2, null), 'live' as never).fault).toBeNull();
		expect(diagnose(sent(0, null)).fault).toBeNull();
		// the game's clock is never set against the panel's: a last success it dates a week ago
		// (or a week ahead) changes nothing
		expect(diagnose(sent(2, Date.parse(started) / 1000 - 7 * 86400)).fault).toBe('otherToken');
		expect(
			diagnose(sent(2, Date.parse(started) / 1000 + 7 * 86400), 'live' as never).fault
		).toBeNull();
	});

	test('of two lines for this panel, the failing one is told', () => {
		const r = feedReportOf({
			enabled: true,
			endpointCount: 2,
			endpoints: [
				{ ...TLR.endpoints[0], index: 0, healthy: true, lastHttpStatus: 200 },
				{ ...TLR.endpoints[0], index: 1, lastHttpStatus: 401 }
			]
		});
		const d = diagnose(r, 'live' as never);
		expect([d.fault, d.endpoint?.index]).toEqual(['token', 1]);
	});
});

describe('the feed action', () => {
	const client = (key: string) =>
		new WardogsClient({} as Env, { id: key, host: 'demo', port: 1, scheme: 'http' }, 'demo', key);

	test("reads the game's report and keeps it to the known fields", async () => {
		setMockFeed('feed-report-a', { ...TLR, extra: 'not kept' });
		expect(await ACTIONS.feed.run(client('feed-report-a'), {})).toEqual(feedReportOf(TLR)!);
	});

	test('a feed that is off by default, and an answer that is not a report refused', async () => {
		expect(await ACTIONS.feed.run(client('feed-report-b'), {})).toEqual({
			enabled: false,
			endpointCount: 0,
			endpoints: []
		});
		setMockFeed('feed-report-c', { nope: true });
		await expect(ACTIONS.feed.run(client('feed-report-c'), {})).rejects.toMatchObject({
			status: 502,
			code: 'bad_response'
		});
	});
});
