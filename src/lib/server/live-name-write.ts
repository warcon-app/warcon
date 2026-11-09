// The Live server name rule's write, at the worker's look (live-name.ts says when and why).
import { ApiError, forLog } from './http';
import { configResult, readConfig } from './actions';
import { classifyGameError, GameError, type WardogsClient } from './rcon';
import { syncPhrase } from './lists-sync';
import { applyTriggerUpdates } from './outbox';
import { withOwnedTransaction } from './leadership';
import {
	LIVE_NAME_EVERY_MS,
	LIVE_NAME_SAME_MS,
	liveNameState,
	nameDue,
	validateLiveName,
	type LiveNameState,
	type NameMemory
} from './live-name';
import type { Env } from './env';
import type { TriggerRow } from './db/schema';
import { getScalar, parseIni, setScalarInText, unquote } from '../config-doc';
import { lockedKeys, S_SESSION } from '../config-fields';
import { liveName } from '../live-name';
import type { ConfigSection, Status } from '../types';

const PINNED =
	"ServerName is pinned by a launch argument on this server's command line, so the panel cannot change it.";

/** A failed write in a fixed phrase: the game's words go to the log only. */
export function nameRefusal(err: unknown): string {
	if (err instanceof GameError && err.code === 'pinned') return PINNED;
	if (err instanceof ApiError) return syncPhrase(err);
	console.warn('[warcon] live server name:', forLog(err));
	return 'The name could not be written.';
}

const isServerName = (section: string, key: string) =>
	section.toLowerCase() === S_SESSION.toLowerCase() && key.toLowerCase() === 'servername';

/** Refusals that hold until the server's own setup changes: tried again only every ten minutes. */
const lasting = (err: unknown) =>
	err instanceof GameError &&
	(err.status === 405 || ['pinned', 'config_readonly', 'no_route'].includes(err.code));

/**
 * ServerName set in the config document, against the revision read: only that line changes. With
 * `ifNow`, only while the document still holds that name ('changed' when it holds another: someone
 * set one since). A document that already holds the name is not written again ('same'), nor is a
 * revision conflict tried again here (the next look tries). Refusals carry status and code only.
 */
export async function writeServerName(
	client: WardogsClient,
	name: string,
	ifNow?: string
): Promise<'written' | 'same' | 'changed'> {
	const doc = await readConfig(client);
	if (!doc.writable)
		throw new GameError(409, 'The config document is read-only.', 'config_readonly');
	if (lockedKeys(doc.sections as ConfigSection[]).some((k) => isServerName(k.section, k.key)))
		throw new GameError(409, 'ServerName is pinned.', 'pinned');
	// as the document reads: a name written in quotes reads without them
	const held = getScalar(parseIni(doc.text), S_SESSION, 'ServerName') ?? '';
	if (held === unquote(name)) return 'same';
	if (ifNow !== undefined && held !== unquote(ifNow)) return 'changed';
	const text = setScalarInText(doc.text, S_SESSION, 'ServerName', name);
	if (text === doc.text) return 'same';
	const { status, body, etag } = await client.configCall('PUT', '/v1/config', text, doc.revision);
	const r = configResult(status, body, etag);
	if (r.ok) return 'written';
	if (r.conflict)
		throw new GameError(412, 'The config document changed meanwhile.', 'revision_conflict');
	const e = classifyGameError('PUT', '/v1/config', status, '', body);
	e.body = null;
	throw e;
}

/** The parts of the worker's memory of a server this reads and moves. */
export interface NameLook {
	status: Status | null;
	liveName: NameMemory | null;
	holdUntil: number;
}

/**
 * One look: the rule's name written when it is due, or, with the rule gone from the enabled ones,
 * its own name put back. That is decided from the document, not the status the look holds (which
 * can be older than the last write): only where this process wrote a name and the document still
 * holds it, so a name someone set after switching the rule off stands. The row records what became
 * of it.
 */
export async function keepName(
	env: Env,
	m: NameLook,
	client: WardogsClient,
	rule: TriggerRow | undefined,
	now: number,
	period: number
): Promise<void> {
	const status = m.status;
	if (!status) return;
	const cfg = rule ? validateLiveName(rule.config) : null;
	if (rule && cfg)
		m.liveName = {
			...(m.liveName ?? { attemptAt: 0, written: '', writtenAt: 0, refused: '' }),
			ruleId: rule.id,
			base: cfg.base
		};
	const mem = m.liveName;
	if (!mem) return;
	const want = cfg ? liveName(cfg, status) : mem.base;
	if (cfg) {
		if (!nameDue(mem, want, status.serverName, now)) return;
	} else {
		// Off with nothing written by this process: nothing of its own to take back.
		if (!mem.written) {
			m.liveName = null;
			return;
		}
		if (now - mem.attemptAt < LIVE_NAME_EVERY_MS) return;
	}
	mem.attemptAt = now;
	let refused = '';
	try {
		const done = await writeServerName(client, want, cfg ? undefined : mem.written);
		if (done === 'changed') {
			m.liveName = null;
			return;
		}
		mem.written = want;
		mem.writtenAt = now;
	} catch (err) {
		if (err instanceof GameError && err.code === 'rate_limited')
			m.holdUntil = Math.max(m.holdUntil, now + (err.retryAfterMs || 5000));
		if (lasting(err)) mem.attemptAt = now + LIVE_NAME_SAME_MS - LIVE_NAME_EVERY_MS;
		refused = nameRefusal(err);
	}
	// A refusal is recorded when it is new; a write every time, which is what the row shows.
	if (refused && refused === mem.refused) return;
	mem.refused = refused;
	const was = rule ? liveNameState(rule.state) : null;
	const state: LiveNameState = refused
		? {
				name: mem.written || was?.name || '',
				at: mem.writtenAt || was?.at || 0,
				refused,
				since: now,
				restored: false
			}
		: { name: want, at: now, refused: '', since: 0, restored: !cfg };
	if (!cfg && !refused) m.liveName = null;
	await withOwnedTransaction(
		env,
		(tx) =>
			applyTriggerUpdates(tx, [
				{ id: mem.ruleId, state, ...(refused ? {} : { lastFiredAt: new Date(now) }) }
			]),
		{ period }
	);
}
