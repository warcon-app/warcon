// The /api/servers/:id/rcon/:action handler: role check, action dispatch, audit row.
import type { RequestEvent } from '@sveltejs/kit';
import { flag, getEnv } from './env';
import { ApiError, apiJson, readJson } from './http';
import { writeAudit } from './audit';
import { getServer, requireUser, roleAtLeast, serverRoleFor } from './access';
import { ACTIONS, ACTION_NAMES } from './actions';
import { GameError, WardogsClient } from './rcon';
import { assertRate } from './ratelimit';

function safe(fn: () => string): string {
	try {
		return fn();
	} catch {
		return '';
	}
}

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
	const def = ACTIONS[name];
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
	const role = server ? await serverRoleFor(env, user, serverId) : null;
	if (!server || !role) throw new ApiError(404, 'Server not found.', 'not_found');

	const auditReads = flag(env.AUDIT_LOG_READS, false);
	const target = def.target ? safe(() => def.target!(params)) : '';
	const base = {
		actor: user,
		server: { id: server.id, name: server.name },
		category: 'rcon' as const,
		action: `rcon.${name}`,
		target
	};

	if (!roleAtLeast(role, def.level)) {
		await writeAudit(env, req, {
			...base,
			outcome: 'denied',
			status: 403,
			message: `Needs '${def.level}', has '${role}'`,
			detail: params
		});
		throw new ApiError(
			403,
			`'${name}' needs the '${def.level}' role on ${server.name}; you have '${role}'.`,
			'forbidden'
		);
	}

	if (name === 'raw') assertRate(`raw:${user.id}`, 30, 60_000);

	const started = Date.now();
	try {
		const client = await WardogsClient.forServer(env, server);
		const result = await def.run(client, params);
		const durationMs = Date.now() - started;
		if (def.mutating || auditReads) {
			await writeAudit(env, req, {
				...base,
				outcome: 'ok',
				status: 200,
				message: messageOf(result),
				detail: def.mutating ? params : undefined,
				durationMs
			});
		}
		return apiJson({ ok: true, action: name, role, result, durationMs });
	} catch (err) {
		const durationMs = Date.now() - started;
		if (err instanceof GameError) {
			if (def.mutating || auditReads || err.status === 401) {
				await writeAudit(env, req, {
					...base,
					outcome: 'error',
					status: err.status,
					message: err.message,
					detail: def.mutating ? params : undefined,
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
						body: err.body ?? undefined
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
					detail: params,
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
			detail: def.mutating ? params : undefined,
			durationMs
		});
		throw err;
	}
}
