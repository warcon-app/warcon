// A failed query's message lists its parameters (Drizzle: "Failed query: <sql>\nparams: <params>").
// Nothing logs, stores or answers that text: the log gets it through forLog, without the
// parameters; a row or a client gets a fixed phrase.
import { expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stage, type ServerMemory } from './observe';
import { serializeError, type RelayError } from './relay';
import { evaluateTriggers, validateConfig, type Evaluation, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';
import type { Env } from './env';

const failedQuery = () =>
	new DrizzleQueryError(
		'insert into "player_names" ("steam_id", "name") values ($1, $2)',
		['76561190000000001', 'Quiet Fixture'],
		new Error('deadlock detected')
	);

/** Everything the console was handed while `fn` ran, as one text. */
async function logged(fn: () => Promise<unknown>): Promise<string> {
	const out: unknown[] = [];
	const saved = { warn: console.warn, error: console.error, log: console.log };
	console.warn = console.error = console.log = (...args: unknown[]) => void out.push(...args);
	try {
		await fn();
	} finally {
		Object.assign(console, saved);
	}
	return out
		.map((a) => (a instanceof Error ? `${a.stack}\n${String(a.cause)}` : String(a)))
		.join('\n');
}

test('a housekeeping stage that fails on a query logs it without the parameters', async () => {
	const m = { server: { name: 'Fixture server' } } as unknown as ServerMemory;
	const text = await logged(() =>
		stage('lists', m, async () => {
			throw failedQuery();
		})
	);
	expect(text).not.toContain('76561190000000001');
	expect(text).not.toContain('Quiet Fixture');
	expect(text).toContain('lists Fixture server');
	expect(text).toContain('insert into "player_names"');
	expect(text).toContain('deadlock detected');
});

test('the worker sends the web a fixed phrase for its own failure, and logs it without the parameters', async () => {
	let sent: RelayError | undefined;
	const text = await logged(async () => {
		sent = serializeError(failedQuery());
	});
	expect(JSON.stringify(sent)).not.toContain('76561190000000001');
	expect(JSON.stringify(sent)).not.toContain('Quiet Fixture');
	expect(sent).toEqual({ kind: 'other', status: 500, message: 'Internal error.' });
	expect(text).not.toContain('76561190000000001');
	expect(text).toContain('deadlock detected');
});

test('a rule whose check fails on a query records a fixed phrase, and the log has no parameters', async () => {
	const row = {
		id: 'rule-reset',
		name: 'Fixture reset',
		kind: 'empty_reset',
		config: validateConfig('empty_reset', { map: 'Fixture map', afterMinutes: 10 }),
		state: null,
		lastFiredAt: null
	} as unknown as TriggerRow;
	const ctx = {
		server: { id: 'srv', name: 'Fixture server' },
		status: { map: 'Other map', experiences: [], playerCount: 0 },
		players: [],
		ts: new Date()
	} as unknown as TickContext;
	// the samples read fails
	const env = {
		db: {
			select: () => {
				throw failedQuery();
			}
		}
	} as unknown as Env;
	let ev: Evaluation | undefined;
	const text = await logged(async () => {
		ev = await evaluateTriggers(env, ctx, [row]);
	});
	expect(JSON.stringify(ev)).not.toContain('76561190000000001');
	expect(ev?.updates).toEqual([
		{ id: 'rule-reset', lastResult: 'Error: the rule could not be checked.' }
	]);
	expect(text).not.toContain('76561190000000001');
	expect(text).toContain('Fixture reset');
	expect(text).toContain('deadlock detected');
});

test("Better Auth's own log of a failed query leaves the parameters out", async () => {
	const { initAuth } = await import('./auth');
	const auth = initAuth({
		ORIGIN: 'http://localhost:5173',
		BETTER_AUTH_SECRET: 'fixture-secret-0123456789-fixture-secret',
		db: {}
	} as unknown as Env);
	const { logger } = await auth.$context;
	const failed = new DrizzleQueryError(
		'insert into "session" ("token", "user_id") values ($1, $2)',
		['fixture-session-token', 'u_fixture'],
		new Error('could not extend file: No space left on device')
	);
	const text = await logged(async () => {
		// the two ways its endpoint error handler logs a failure
		logger.error(failed.name, failed);
		logger.error(failed.message);
	});
	expect(text).not.toContain('fixture-session-token');
	expect(text).not.toContain('u_fixture');
	expect(text).toContain('No space left on device');
});

// ---- every console call on the server ----------------------------------------------------------

const SRC = join(import.meta.dir, '..', '..');

/** The worker, the hooks, every server module, endpoint and load: what runs on a box, not a browser. */
function serverSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return serverSources(path);
		if (e.name.endsWith('.test.ts') || !e.name.endsWith('.ts')) return [];
		const rel = relative(SRC, path);
		if (rel.startsWith('routes/'))
			return /^\+(server|page\.server|layout\.server)\.ts$/.test(e.name) ? [path] : [];
		return rel.startsWith('lib/server/') || rel.startsWith('worker/') || rel === 'hooks.server.ts'
			? [path]
			: [];
	});
}

/** Each console call in `text`: its line and its arguments, split at their top-level commas. */
function consoleCalls(text: string): { line: number; args: string[] }[] {
	const calls: { line: number; args: string[] }[] = [];
	for (const m of text.matchAll(/console\.(log|info|warn|error|debug)\(/g)) {
		const args: string[] = [];
		let cur = '';
		let depth = 1;
		let i = m.index + m[0].length;
		while (i < text.length && depth > 0) {
			const ch = text[i];
			if (ch === "'" || ch === '"' || ch === '`') {
				// a string or a template whole: its commas and brackets are not the call's
				let j = i + 1;
				while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
				cur += text.slice(i, j + 1);
				i = j + 1;
				continue;
			}
			if ('([{'.includes(ch)) depth++;
			else if (')]}'.includes(ch)) depth--;
			if (depth === 0 || (depth === 1 && ch === ',')) {
				args.push(cur.trim());
				cur = '';
			} else cur += ch;
			i++;
		}
		calls.push({ line: text.slice(0, m.index).split('\n').length, args: args.filter(Boolean) });
	}
	return calls;
}

/** An argument that hands the console an error itself, its message or its stack. */
const RAW_ERROR =
	/^(err|e|error)$|\b(err|e|error)\.(message|stack)\b|String\((err|e|error)\)|\$\{(err|e|error)\b/;

test('no console call on the server logs an error but through forLog or publicMessage', () => {
	const files = serverSources(SRC);
	expect(files.length).toBeGreaterThan(50);
	const raw: string[] = [];
	for (const file of files)
		for (const call of consoleCalls(readFileSync(file, 'utf8')))
			for (const arg of call.args)
				if (RAW_ERROR.test(arg)) raw.push(`${relative(SRC, file)}:${call.line}: ${arg}`);
	expect(raw).toEqual([]);
});

test('the scan sees an error handed to the console however it is written', () => {
	const flagged = (src: string) =>
		consoleCalls(src).flatMap((c) => c.args.filter((a) => RAW_ERROR.test(a)));
	expect(flagged("console.error('[warcon] x', err);")).toEqual(['err']);
	expect(
		flagged('console.warn(`[warcon] ${name}:`, err instanceof Error ? err.message : err);')
	).toHaveLength(1);
	expect(flagged("console.error('x', e.stack, `(${err})`)")).toHaveLength(2);
	expect(flagged("console.error('[warcon] x', forLog(err));")).toEqual([]);
	expect(flagged("console.warn('[warcon] x:', publicMessage(e), 'a, (b)');")).toEqual([]);
});
