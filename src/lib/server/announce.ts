// One message to several servers of an organisation at once: a broadcast on each, as if it had
// been sent from each server's Overview. Each server needs Chat and gets its own audit row (and so
// its own Discord line), so a server's trail shows every line it was sent. A request that names a
// server the caller may not chat on, or cannot see, sends nothing.
import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, forLog, str } from './http';
import { writeAudit } from './audit';
import {
	accessibleServers,
	getOrg,
	type OrgRow,
	type ServerSummary,
	type SessionUser
} from './access';
import { CAPABILITY_INFO } from '../capabilities';
import { MAX_CHAT } from '../chat';
import { gateway } from './gateway';
import { GameError } from './rcon';
import { takeRate } from './ratelimit';
import { ACTIONS_PER_MINUTE, actionBudget, messageOf } from './rcon-run';
import { servers, type ServerRow } from './db/schema';
import type { AnnounceAnswer, AnnounceResult } from '../types';

/** The most servers one announcement reaches: every one is a game action of the caller's budget. */
export const ANNOUNCE_MAX = ACTIONS_PER_MINUTE;

const CHAT = 'chat.send';
const tooMany = () =>
	new ApiError(400, `An announcement reaches at most ${ANNOUNCE_MAX} servers.`, 'too_many');

/**
 * The servers of the org the caller can open, checked before the request's body is read: nobody
 * who can open none of them learns the org is there, and somebody who may chat on none of them is
 * refused whatever they asked for.
 */
export async function announceAccess(
	env: Env,
	user: SessionUser,
	orgId: string
): Promise<{ org: OrgRow; visible: ServerSummary[] }> {
	const org = await getOrg(env, orgId);
	const visible = org ? await accessibleServers(env, user, org.id) : [];
	if (!org || !visible.length) throw new ApiError(404, 'Organisation not found.', 'not_found');
	if (!visible.some((s) => s.caps.includes(CHAT)))
		throw new ApiError(
			403,
			`This needs '${CAPABILITY_INFO[CHAT].label}' on a server of ${org.name}.`,
			'forbidden'
		);
	return { org, visible };
}

/**
 * Sends `body.message` to the servers `body.serverIds` names (null: every server of the org the
 * caller may chat on), at once, each through its own lane. Throws, with nothing sent, for a bad
 * request, a server the caller cannot see (404), a full action budget (429), or a server the
 * caller may not chat on (403, with a denied row on that server as a single broadcast writes);
 * otherwise answers how each server took it.
 */
export async function announce(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	visible: ServerSummary[],
	raw: unknown
): Promise<AnnounceAnswer> {
	const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const message = str(body.message, MAX_CHAT);
	if (!message) throw new ApiError(400, 'message is required.');

	let targets: ServerSummary[];
	if (body.serverIds === null) targets = visible.filter((s) => s.caps.includes(CHAT));
	else {
		const asked = body.serverIds;
		const ids =
			Array.isArray(asked) && asked.every((v) => typeof v === 'string')
				? [...new Set(asked.map((v) => str(v, 64)).filter(Boolean))]
				: [];
		if (!ids.length)
			throw new ApiError(
				400,
				'Name the servers in serverIds, or send null for every server you may chat on.',
				'bad_scope'
			);
		if (ids.length > ANNOUNCE_MAX) throw tooMany();
		const byId = new Map(visible.map((s) => [s.id, s]));
		// Another org's server, one not shared with the caller and one that does not exist answer alike.
		if (ids.some((id) => !byId.has(id))) throw new ApiError(404, 'Server not found.', 'not_found');
		targets = ids.map((id) => byId.get(id)!);
	}
	if (targets.length > ANNOUNCE_MAX) throw tooMany();
	// Every server named is one of the caller's game actions, sent or turned away, so a refusal's
	// trail rows are bounded as the sends are; and the whole announcement or none of it.
	const wait = takeRate(actionBudget(user.id), targets.length, ACTIONS_PER_MINUTE, 60_000);
	if (wait)
		throw new ApiError(
			429,
			`Too many requests; try again in ${wait} second${wait === 1 ? '' : 's'}.`,
			'rate_limited'
		);
	const refused = targets.filter((s) => !s.caps.includes(CHAT));
	if (refused.length) {
		for (const s of refused)
			await writeAudit(env, req, {
				...auditBase(user, s, message),
				outcome: 'denied',
				status: 403,
				message: `Needs '${CHAT}', role '${s.roleName}' lacks it`,
				detail: { message }
			});
		throw new ApiError(
			403,
			`This needs '${CAPABILITY_INFO[CHAT].label}' on ${refused[0].name}; your role '${refused[0].roleName}' does not include it.`,
			'forbidden'
		);
	}

	const rows = await env.db
		.select()
		.from(servers)
		.where(
			inArray(
				servers.id,
				targets.map((s) => s.id)
			)
		);
	const rowOf = new Map(rows.map((r) => [r.id, r]));
	// The same id on every server's row ties them together. Not how many servers it went to: Audit
	// trail on one server shows that server's row alone, and the others are none of its business.
	const detail = { message, announcement: { id: randomBytes(4).toString('hex') } };
	const results = await Promise.all(
		targets.map((s) => {
			const row = rowOf.get(s.id);
			return row && row.orgId === org.id
				? sendTo(env, req, user, row, message, detail)
				: {
						serverId: s.id,
						serverName: s.name,
						ok: false,
						message: 'Server not found.',
						code: 'not_found'
					};
		})
	);
	const sent = results.filter((r) => r.ok).length;
	return { sent, failed: results.length - sent, results };
}

const auditBase = (
	user: SessionUser,
	s: { id: string; name: string; orgId: string },
	message: string
) => ({
	actor: user,
	server: { id: s.id, name: s.name },
	orgId: s.orgId,
	category: 'rcon' as const,
	action: 'rcon.broadcast',
	target: message
});

/** One server's broadcast and its audit row; what went wrong is the answer, never a throw. */
async function sendTo(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	message: string,
	detail: object
): Promise<AnnounceResult> {
	const base = auditBase(user, server, message);
	const started = Date.now();
	const answer = { serverId: server.id, serverName: server.name };
	let outcome: AnnounceResult;
	/** what the trail keeps: the status and the words, as a single broadcast's row has them */
	let row: { status: number; message: string };
	try {
		const result = await gateway().run(env, server, 'broadcast', { message });
		gateway().observeSoon(server.id);
		outcome = { ...answer, ok: true, message: messageOf(result) };
		row = { status: 200, message: outcome.message };
	} catch (err) {
		// The game's refusals and the panel's own (a busy lane, the worker away) are written for
		// people; anything else is logged and stands as a fixed phrase, as a single broadcast does.
		if (err instanceof ApiError) {
			row = { status: err.status, message: err.message };
			outcome = {
				...answer,
				ok: false,
				message:
					err instanceof GameError && err.status === 401
						? `The game server rejected the stored RCON password: ${err.message}`
						: err.message,
				code: err.code || undefined
			};
		} else {
			console.error('[warcon] announcement', forLog(err));
			row = { status: 500, message: 'Internal error.' };
			outcome = { ...answer, ok: false, message: 'Internal error.', code: 'internal' };
		}
	}
	try {
		await writeAudit(env, req, {
			...base,
			outcome: outcome.ok ? 'ok' : 'error',
			...row,
			detail,
			durationMs: Date.now() - started
		});
	} catch (err) {
		// The line went out (or did not) all the same: the answer says which.
		console.error('[warcon] announcement audit', forLog(err));
	}
	return outcome;
}
