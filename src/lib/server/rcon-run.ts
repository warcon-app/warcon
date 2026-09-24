// The /api/servers/:id/rcon/:action handler: capability check, action dispatch, audit row.
import type { RequestEvent } from '@sveltejs/kit';
import { flag, getEnv } from './env';
import { ApiError, apiJson, readJson } from './http';
import { writeAudit } from './audit';
import { getServer, requireUser, serverAccessFor } from './access';
import { CAPABILITY_INFO } from '../capabilities';
import { ACTION_NAMES, actionDef } from './actions';
import { GameError } from './rcon';
import { gateway } from './gateway';
import { assertRate } from './ratelimit';
import { noteLocalEdit } from './lists-sync';
import type { Kind } from './lists-plan';

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/** Actions that edit a list the worker mirrors in server_bans / server_reserved. */
const LIST_EDITS: Record<string, { kind: Kind; op: 'add' | 'remove' }> = {
	ban: { kind: 'ban', op: 'add' },
	unban: { kind: 'ban', op: 'remove' },
	reservedAdd: { kind: 'reserve', op: 'add' },
	reservedRemove: { kind: 'reserve', op: 'remove' }
};

function messageOf(result: unknown): string {
	if (
		result &&
		typeof result === 'object' &&
		'message' in result &&
		typeof (result as { message: unknown }).message === 'string'
	) {
		return (result as { message: string }).message;
	}
	return '';
}

export async function runAction(
	event: RequestEvent,
	serverId: string,
	name: string
): Promise<Response> {
	const env = getEnv();
	const req = event.request;
	const def = actionDef(name);
	if (!def)
		throw new ApiError(
			404,
			`Unknown action '${name}'. Known: ${ACTION_NAMES.join(', ')}`,
			'unknown_action'
		);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const params: any =
		req.method === 'GET'
			? Object.fromEntries(event.url.searchParams.entries())
			: await readJson(req);
	if (req.method === 'GET' && def.mutating)
		throw new ApiError(405, 'Mutating actions must be POSTed.');

	const user = requireUser(event.locals);
	const server = await getServer(env, serverId);
	const access = server ? await serverAccessFor(env, user, serverId) : null;
	if (!server || !access) throw new ApiError(404, 'Server not found.', 'not_found');

	const auditReads = flag(env.AUDIT_LOG_READS, false);
	const target = def.target ? safe(() => def.target!(params), '') : '';
	// What the trail keeps of the request: the action's own safe shape when it has one, else the
	// params (writeAudit redacts by key name and secret-looking lines on insert).
	const detail: unknown = def.audit ? safe(() => def.audit!(params), undefined) : params;
	const base = {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'rcon' as const,
		action: `rcon.${name}`,
		target
	};

	if (!access.caps.has(def.cap)) {
		await writeAudit(env, req, {
			...base,
			outcome: 'denied',
			status: 403,
			message: `Needs '${def.cap}', role '${access.roleName}' lacks it`,
			detail
		});
		throw new ApiError(
			403,
			`'${name}' needs '${CAPABILITY_INFO[def.cap].label}' on ${server.name}; your role '${access.roleName}' does not include it.`,
			'forbidden'
		);
	}

	if (name === 'raw') assertRate(`raw:${user.id}`, 30, 60_000);
	// Pages read the live view; direct game reads are for tools and the odd refresh, not a poll loop.
	assertRate(`rcon:${user.id}`, 120, 60_000);

	// The game's answers as it sent them are what a connection test shows, and that needs Config
	// & settings; a viewer gets the shaped status and the feature list.
	const unshaped = access.caps.has('config.apply');
	if (name === 'status' && !unshaped) delete params.raw;

	const started = Date.now();
	try {
		const result = await gateway().run(env, server, name, params);
		if (name === 'capabilities' && !unshaped && result && typeof result === 'object')
			delete (result as { raw?: unknown }).raw;
		// Addresses are for the site owner alone: the listener's log keeps its events, not its peers.
		if (name === 'serverLog' && user.role !== 'owner')
			for (const e of (result as { entries?: { peer: string }[] })?.entries ?? []) e.peer = '';
		const durationMs = Date.now() - started;
		// The panel shows what the worker last saw; after a change, have it look again now. A list
		// edit also rewrites the mirror here, so the change shows before the worker's re-read lands.
		const listEdit = LIST_EDITS[name];
		if (listEdit && /^\d{17}$/.test(target)) {
			await noteLocalEdit(
				env,
				server.id,
				listEdit.kind,
				listEdit.op,
				target,
				typeof params?.reason === 'string' ? params.reason.slice(0, 200) : ''
			).catch((err) => console.error('[warcon] list mirror', err));
		}
		if (def.mutating) gateway().observeSoon(server.id, { lists: !!listEdit });
		// A new document may change MaxReservedSlots, which the worker otherwise re-reads hourly.
		if (name === 'configApply') gateway().identityChanged(server.id);
		if (def.mutating || auditReads) {
			// An action that took another path than the caller asked for (reserved slots written to
			// the config document) says so in the trail, with the revision it produced.
			const meta =
				result && typeof result === 'object' && 'via' in result
					? {
							via: (result as { via: unknown }).via,
							revision: (result as { revision?: unknown }).revision
						}
					: null;
			await writeAudit(env, req, {
				...base,
				outcome: 'ok',
				status: 200,
				message: messageOf(result),
				detail: def.mutating
					? meta && detail && typeof detail === 'object'
						? { ...(detail as object), ...meta }
						: detail
					: undefined,
				durationMs
			});
		}
		return apiJson({ ok: true, action: name, role: access.roleName, result, durationMs });
	} catch (err) {
		const durationMs = Date.now() - started;
		if (err instanceof GameError) {
			if (def.mutating || auditReads || err.status === 401) {
				await writeAudit(env, req, {
					...base,
					outcome: 'error',
					status: err.status,
					message: err.message,
					detail: def.mutating ? detail : undefined,
					durationMs
				});
			}
			// 401 from the game server means the stored RCON password is wrong; surface it clearly.
			const status = err.status === 401 ? 502 : err.status >= 500 ? 502 : err.status;
			return apiJson(
				{
					ok: false,
					action: name,
					error: {
						message:
							err.status === 401
								? `The game server rejected the stored RCON password: ${err.message}`
								: err.message,
						code: err.code || undefined,
						upstreamStatus: err.status,
						// A rejected config document's error lines can quote the file, so the game's body
						// reaches only callers entitled to the document or to raw access.
						body:
							def.cap === 'rcon.raw' || def.cap === 'config.apply'
								? (err.body ?? undefined)
								: undefined
					}
				},
				status
			);
		}
		if (err instanceof ApiError) {
			if (def.mutating)
				await writeAudit(env, req, {
					...base,
					outcome: 'error',
					status: err.status,
					message: err.message,
					detail,
					durationMs
				});
			throw err;
		}
		const message = err instanceof Error ? err.message : String(err);
		await writeAudit(env, req, {
			...base,
			outcome: 'error',
			status: 500,
			message,
			detail: def.mutating ? detail : undefined,
			durationMs
		});
		throw err;
	}
}
