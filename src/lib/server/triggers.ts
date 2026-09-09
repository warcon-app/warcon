// Automation: per-server triggers the poller evaluates on every tick. Four kinds, all built on
// what the poller already sees (joins, player counts, empty stretches) plus the Steam cache:
//   welcome      whisper a message to players as they join
//   broadcast    rotate through messages every N minutes while enough people are on
//   empty_reset  send an empty server back to a chosen map after N minutes
//   risk_kick    kick joiners who match Steam / ban-list rules (see risk.ts)
// Every action lands in the audit trail as category "trigger". A dry run replays the last 24 hours
// from the samples and sessions tables so a rule can be checked before it touches anyone.
import { and, asc, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, int, newId, str } from './http';
import { writeAudit } from './audit';
import { ACTIONS } from './actions';
import { GameError, WardogsClient } from './rcon';
import { playerSessions, samples, triggers, type ServerRow, type TriggerRow } from './db/schema';
import { getProfiles, steamEnabled } from './steam';
import { localSignals, orgServers } from './players';
import type { SessionUser } from './access';
import type { DryRunResult, Player, Status, TriggerKind, TriggerView } from '$lib/types';
import {
	isTriggerKind,
	onTarget,
	renderTemplate,
	riskKickVerdict,
	TRIGGER_LABELS,
	validateConfig,
	type BroadcastConfig,
	type EmptyResetConfig,
	type RiskKickConfig,
	type WelcomeConfig
} from './trigger-rules';

export * from './trigger-rules';

const WINDOW_MS = 24 * 3600_000;

// ---- records ------------------------------------------------------------------------------------

const shape = (t: TriggerRow): TriggerView => ({
	id: t.id,
	kind: t.kind,
	name: t.name,
	enabled: t.enabled,
	config: t.config as Record<string, unknown>,
	lastFiredAt: t.lastFiredAt ? t.lastFiredAt.toISOString() : null,
	lastResult: t.lastResult,
	fireCount: t.fireCount,
	createdAt: t.createdAt ? t.createdAt.toISOString() : null
});

export async function listTriggers(env: Env, serverId: string): Promise<TriggerView[]> {
	const rows = await env.db
		.select()
		.from(triggers)
		.where(eq(triggers.serverId, serverId))
		.orderBy(asc(triggers.createdAt));
	return rows.map(shape);
}

async function triggerOf(env: Env, serverId: string, id: string): Promise<TriggerRow> {
	const [row] = await env.db
		.select()
		.from(triggers)
		.where(and(eq(triggers.id, id), eq(triggers.serverId, serverId)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Trigger not found.');
	return row;
}

export async function createTrigger(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	body: Record<string, unknown>
): Promise<TriggerView> {
	if (!isTriggerKind(body.kind)) throw new ApiError(400, 'Unknown trigger kind.');
	const kind = body.kind;
	const config = validateConfig(kind, body.config);
	const name = str(body.name, 60) || TRIGGER_LABELS[kind];
	const [row] = await env.db
		.insert(triggers)
		.values({
			id: newId(),
			serverId: server.id,
			orgId: server.orgId,
			kind,
			name,
			enabled: !!body.enabled,
			config,
			createdBy: user.id
		})
		.returning();
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'trigger.create',
		target: name,
		outcome: 'ok',
		detail: { triggerId: row.id, kind, enabled: row.enabled, config }
	});
	return shape(row);
}

export async function updateTrigger(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	id: string,
	body: Record<string, unknown>
): Promise<TriggerView> {
	const row = await triggerOf(env, server.id, id);
	const set: Partial<typeof triggers.$inferInsert> = {};
	if (body.name !== undefined) set.name = str(body.name, 60) || row.name;
	if (body.enabled !== undefined) set.enabled = !!body.enabled;
	if (body.config !== undefined) set.config = validateConfig(row.kind, body.config);
	if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	const [updated] = await env.db
		.update(triggers)
		.set(set)
		.where(eq(triggers.id, row.id))
		.returning();
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'trigger.update',
		target: updated.name,
		outcome: 'ok',
		detail: { triggerId: row.id, kind: row.kind, ...set }
	});
	return shape(updated);
}

export async function deleteTrigger(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	id: string
): Promise<void> {
	const row = await triggerOf(env, server.id, id);
	await env.db.delete(triggers).where(eq(triggers.id, row.id));
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'trigger.delete',
		target: row.name,
		outcome: 'ok',
		detail: { triggerId: row.id, kind: row.kind }
	});
}

// ---- running ------------------------------------------------------------------------------------

export interface TickContext {
	server: ServerRow;
	client: WardogsClient;
	status: Status;
	players: Player[];
	/** players with no open session before this tick */
	joined: Player[];
	/** joiners never seen on this server before */
	firstVisit: Set<string>;
	/** SteamIDs with a reserved slot */
	reserved: Set<string>;
	/** false on the first tick of a process and right after an outage, when "joined" means "everyone" */
	joinsReliable: boolean;
	ts: Date;
}

const vars = (ctx: TickContext, p?: Player) => ({
	name: p?.name ?? '',
	server: ctx.status.serverName || ctx.server.name,
	map: ctx.status.map,
	players: ctx.status.playerCount,
	max: ctx.status.maxPlayers
});

async function fired(
	env: Env,
	row: TriggerRow,
	ts: Date,
	count: number,
	result: string,
	state?: unknown
): Promise<void> {
	await env.db
		.update(triggers)
		.set({
			lastFiredAt: count ? ts : undefined,
			lastResult: result.slice(0, 300),
			fireCount: sql`${triggers.fireCount} + ${count}`,
			state: state === undefined ? undefined : state
		})
		.where(eq(triggers.id, row.id));
}

async function auditTrigger(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	target: string,
	outcome: 'ok' | 'error',
	message: string,
	detail: Record<string, unknown>
): Promise<void> {
	await writeAudit(env, null, {
		actorName: `trigger: ${row.name}`,
		server: { id: ctx.server.id, name: ctx.server.name },
		orgId: ctx.server.orgId,
		category: 'trigger',
		action: `trigger.${row.kind}`,
		target,
		outcome,
		status: outcome === 'ok' ? 200 : 502,
		message,
		detail: { triggerId: row.id, ...detail }
	});
}

/** Evaluates every enabled trigger of the server against this tick. Never throws. */
export async function runTriggers(env: Env, ctx: TickContext): Promise<void> {
	let rows: TriggerRow[];
	try {
		rows = await env.db
			.select()
			.from(triggers)
			.where(and(eq(triggers.serverId, ctx.server.id), eq(triggers.enabled, true)));
	} catch (err) {
		console.error('[warcon] triggers', err);
		return;
	}
	for (const row of rows) {
		try {
			await runOne(env, ctx, row);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[warcon] trigger ${row.name}`, message);
			await fired(env, row, ctx.ts, 0, `Error: ${message}`).catch(() => {});
		}
	}
}

async function runOne(env: Env, ctx: TickContext, row: TriggerRow): Promise<void> {
	switch (row.kind) {
		case 'welcome':
			return runWelcome(env, ctx, row, row.config as WelcomeConfig);
		case 'broadcast':
			return runBroadcast(env, ctx, row, row.config as BroadcastConfig);
		case 'empty_reset':
			return runEmptyReset(env, ctx, row, row.config as EmptyResetConfig);
		case 'risk_kick':
			return runRiskKick(env, ctx, row, row.config as RiskKickConfig);
	}
}

/** Runs one game action for a trigger and records it; returns whether it succeeded. */
async function act(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	action: string,
	params: Record<string, unknown>,
	target: string,
	okMessage: string,
	detail: Record<string, unknown>
): Promise<boolean> {
	try {
		const result = (await ACTIONS[action].run(ctx.client, params)) as { message?: string };
		await auditTrigger(env, ctx, row, target, 'ok', result?.message || okMessage, {
			rconAction: action,
			...detail
		});
		return true;
	} catch (err) {
		const message = err instanceof GameError || err instanceof ApiError ? err.message : 'Failed.';
		await auditTrigger(env, ctx, row, target, 'error', message, { rconAction: action, ...detail });
		return false;
	}
}

async function runWelcome(env: Env, ctx: TickContext, row: TriggerRow, cfg: WelcomeConfig) {
	if (!ctx.joinsReliable || !ctx.joined.length) return;
	let n = 0;
	let last = '';
	for (const p of ctx.joined) {
		if (cfg.onlyFirstVisit && !ctx.firstVisit.has(p.steamId)) continue;
		const message = renderTemplate(cfg.message, vars(ctx, p));
		if (
			await act(
				env,
				ctx,
				row,
				'whisper',
				{ steamId: p.steamId, message },
				p.steamId,
				`Whispered ${p.name}.`,
				{ name: p.name }
			)
		)
			n++;
		last = p.name;
	}
	if (n) await fired(env, row, ctx.ts, n, `Whispered ${n === 1 ? last : `${n} players`}`);
}

async function runBroadcast(env: Env, ctx: TickContext, row: TriggerRow, cfg: BroadcastConfig) {
	if (ctx.status.playerCount < cfg.minPlayers) return;
	const due =
		!row.lastFiredAt || ctx.ts.getTime() - row.lastFiredAt.getTime() >= cfg.everyMinutes * 60_000;
	if (!due) return;
	const state = (row.state as { index?: number } | null) ?? {};
	const index = (state.index ?? 0) % cfg.messages.length;
	const message = renderTemplate(cfg.messages[index], vars(ctx));
	const ok = await act(env, ctx, row, 'broadcast', { message }, message, 'Broadcast sent.', {
		index
	});
	await fired(env, row, ctx.ts, ok ? 1 : 0, ok ? `Sent: ${message}` : 'Broadcast failed', {
		index: index + 1
	});
}

async function runEmptyReset(env: Env, ctx: TickContext, row: TriggerRow, cfg: EmptyResetConfig) {
	if (ctx.status.playerCount > 0 || ctx.players.length > 0) return;
	if (onTarget(cfg, ctx.status)) return;
	if (
		row.lastFiredAt &&
		ctx.ts.getTime() - row.lastFiredAt.getTime() < cfg.cooldownMinutes * 60_000
	)
		return;
	// Empty since the last sample that was unreachable or had someone on.
	const [busy] = await env.db
		.select({ ts: samples.ts })
		.from(samples)
		.where(
			and(
				eq(samples.serverId, ctx.server.id),
				or(eq(samples.ok, false), sql`${samples.playerCount} > 0`)
			)
		)
		.orderBy(desc(samples.ts))
		.limit(1);
	const [oldest] = busy
		? []
		: await env.db
				.select({ ts: samples.ts })
				.from(samples)
				.where(eq(samples.serverId, ctx.server.id))
				.orderBy(asc(samples.ts))
				.limit(1);
	const since = busy?.ts ?? oldest?.ts;
	if (!since || ctx.ts.getTime() - since.getTime() < cfg.afterMinutes * 60_000) return;
	const sel = {
		map: cfg.map,
		experiences: cfg.experiences,
		lighting: cfg.lighting || undefined,
		zoneAlternator: cfg.zoneAlternator || undefined
	};
	// With a rotation, put the target next and end the match: the game then travels there. Without
	// one, request the map directly; the server travels when the (empty) match ends.
	let rotationOn = false;
	try {
		rotationOn = !!((await ACTIONS.rotation.run(ctx.client, {})) as { enabled: boolean }).enabled;
	} catch {
		/* treat as no rotation */
	}
	const first = rotationOn ? 'setNextMap' : 'changeMap';
	const ok =
		(await act(env, ctx, row, first, sel, cfg.map, `Map set to ${cfg.map}.`, {
			emptyMinutes: Math.round((ctx.ts.getTime() - since.getTime()) / 60_000)
		})) && (await act(env, ctx, row, 'endMatch', {}, cfg.map, 'Match ended.', {}));
	await fired(env, row, ctx.ts, ok ? 1 : 0, ok ? `Reset to ${cfg.map}` : 'Map reset failed');
}

async function runRiskKick(env: Env, ctx: TickContext, row: TriggerRow, cfg: RiskKickConfig) {
	if (!ctx.joinsReliable || !ctx.joined.length) return;
	const org = await orgServers(env, ctx.server.orgId);
	const [signals, profiles] = await Promise.all([
		localSignals(
			env,
			ctx.server.orgId,
			org.map((s) => s.id),
			ctx.server.id,
			ctx.joined
		),
		steamEnabled(env)
			? getProfiles(
					env,
					ctx.joined.map((p) => p.steamId)
				)
			: new Map()
	]);
	let n = 0;
	let last = '';
	for (const p of ctx.joined) {
		const l = signals.get(p.steamId);
		const verdict = riskKickVerdict(cfg, {
			profile: profiles.get(p.steamId) ?? null,
			steamEnabled: steamEnabled(env),
			bannedOn: l?.bannedOn ?? [],
			watched: l?.watched ?? null,
			reserved: ctx.reserved.has(p.steamId),
			now: ctx.ts
		});
		if (!verdict) continue;
		if (
			await act(
				env,
				ctx,
				row,
				'kick',
				{ steamId: p.steamId, reason: cfg.reason },
				p.steamId,
				`Kicked ${p.name}: ${verdict}`,
				{
					name: p.name,
					verdict
				}
			)
		) {
			n++;
			last = `${p.name}: ${verdict}`;
		}
	}
	if (n) await fired(env, row, ctx.ts, n, n === 1 ? `Kicked ${last}` : `Kicked ${n} players`);
}

// ---- dry run ------------------------------------------------------------------------------------

/** Replays the last 24 hours of this server's history against a rule. Touches nobody. */
export async function dryRun(
	env: Env,
	server: ServerRow,
	kind: TriggerKind,
	rawConfig: unknown,
	client?: WardogsClient
): Promise<DryRunResult> {
	const cfg = validateConfig(kind, rawConfig);
	const to = new Date();
	const from = new Date(to.getTime() - WINDOW_MS);
	const result: DryRunResult = {
		kind,
		from: from.toISOString(),
		to: to.toISOString(),
		fires: 0,
		items: [],
		notes: []
	};
	const push = (at: Date, text: string) => {
		result.fires++;
		if (result.items.length < 50) result.items.push({ at: at.toISOString(), text });
	};
	const joins = () =>
		env.db.execute<{
			steamId: string;
			name: string;
			joinedAt: Date;
			first: boolean;
		}>(sql`
			SELECT s.steam_id AS "steamId", s.name, s.joined_at AS "joinedAt",
			       NOT EXISTS (SELECT 1 FROM player_sessions e WHERE e.server_id = s.server_id AND e.steam_id = s.steam_id AND e.joined_at < s.joined_at) AS first
			  FROM player_sessions s
			 WHERE s.server_id = ${server.id} AND s.joined_at >= ${from}
			 ORDER BY s.joined_at ASC LIMIT 500`);

	if (kind === 'welcome') {
		const c = cfg as WelcomeConfig;
		for (const j of await joins()) {
			if (c.onlyFirstVisit && !j.first) continue;
			push(
				new Date(j.joinedAt),
				`whisper ${j.name}: ${renderTemplate(c.message, { name: j.name, server: server.name, map: '…', players: '…', max: '…' })}`
			);
		}
		result.notes.push(
			c.onlyFirstVisit
				? 'Only joiners never seen on this server before count.'
				: 'Every join counts, including people who reconnect.'
		);
		return result;
	}
	if (kind === 'risk_kick') {
		const c = cfg as RiskKickConfig;
		const rows = await joins();
		const seen = new Map<string, { name: string; joinedAt: Date }>();
		for (const j of rows)
			if (!seen.has(j.steamId))
				seen.set(j.steamId, { name: j.name, joinedAt: new Date(j.joinedAt) });
		const players = [...seen.entries()].map(([steamId, v]) => ({ steamId, name: v.name }));
		const org = await orgServers(env, server.orgId);
		let reserved = new Set<string>();
		if (client) {
			try {
				reserved = new Set(
					((await ACTIONS.reserved.run(client, {})) as { reserved: string[] }).reserved
				);
			} catch {
				result.notes.push('Could not read the reserved slots; nobody was spared for one.');
			}
		}
		const [signals, profiles] = await Promise.all([
			localSignals(
				env,
				server.orgId,
				org.map((s) => s.id),
				server.id,
				players
			),
			steamEnabled(env)
				? getProfiles(
						env,
						players.slice(0, 200).map((p) => p.steamId)
					)
				: new Map()
		]);
		for (const p of players) {
			const l = signals.get(p.steamId);
			const verdict = riskKickVerdict(c, {
				profile: profiles.get(p.steamId) ?? null,
				steamEnabled: steamEnabled(env),
				bannedOn: l?.bannedOn ?? [],
				watched: l?.watched ?? null,
				reserved: reserved.has(p.steamId),
				now: to
			});
			if (verdict) push(seen.get(p.steamId)!.joinedAt, `kick ${p.name} (${p.steamId}): ${verdict}`);
		}
		if (!steamEnabled(env))
			result.notes.push(
				'Steam lookup is off (STEAM_API_KEY): the VAC, game-ban and account-age rules were skipped.'
			);
		result.notes.push(
			`${players.length} distinct player${players.length === 1 ? '' : 's'} joined in the window.`
		);
		return result;
	}
	const rows = await env.db
		.select({
			ts: samples.ts,
			ok: samples.ok,
			count: samples.playerCount,
			map: samples.map,
			experiences: samples.experiences
		})
		.from(samples)
		.where(and(eq(samples.serverId, server.id), gte(samples.ts, from)))
		.orderBy(asc(samples.ts));
	if (!rows.length) {
		result.notes.push('No samples in the last 24 hours; the poller may be off or the server new.');
		return result;
	}
	if (kind === 'broadcast') {
		const c = cfg as BroadcastConfig;
		let last: Date | null = null;
		let index = 0;
		for (const r of rows) {
			if (!r.ok || (r.count ?? 0) < c.minPlayers) continue;
			if (last && r.ts.getTime() - last.getTime() < c.everyMinutes * 60_000) continue;
			last = r.ts;
			push(r.ts, `broadcast (${r.count} on): ${c.messages[index++ % c.messages.length]}`);
		}
		return result;
	}
	const c = cfg as EmptyResetConfig;
	let emptySince: Date | null = null;
	let last: Date | null = null;
	for (const r of rows) {
		const empty = r.ok && (r.count ?? 0) === 0;
		if (!empty) {
			emptySince = null;
			continue;
		}
		emptySince ??= r.ts;
		const there = onTarget(c, {
			map: r.map || '',
			experiences: r.experiences ? r.experiences.split('+') : []
		});
		if (there) continue;
		if (r.ts.getTime() - emptySince.getTime() < c.afterMinutes * 60_000) continue;
		if (last && r.ts.getTime() - last.getTime() < c.cooldownMinutes * 60_000) continue;
		last = r.ts;
		push(
			r.ts,
			`reset ${r.map || '?'} → ${c.map} after ${Math.round((r.ts.getTime() - emptySince.getTime()) / 60_000)} min empty`
		);
	}
	result.notes.push(
		'A real reset changes the map, so later fires in the same empty stretch would not happen.'
	);
	return result;
}
