// Automation: per-server triggers the worker evaluates on every observation. Four kinds, all
// built on what the worker already sees (joins, player counts, empty stretches) plus the Steam cache:
//   welcome      whisper a message to players as they join
//   broadcast    rotate through messages every N minutes while enough people are on
//   empty_reset  send an empty server back to a chosen map after N minutes
//   risk_kick    kick joiners who match Steam / ban-list rules (see risk.ts)
// The worker evaluates them on every observation and writes the actions they want to the outbox
// (outbox.ts delivers, and every delivery lands in the audit trail as category "trigger"). A dry
// run replays the last 24 hours from the samples and sessions tables so a rule can be checked
// before it touches anyone.
import { and, asc, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, int, newId, str } from './http';
import { writeAudit } from './audit';
import {
	playerSessions,
	samples,
	triggers,
	type ServerRow,
	type SteamProfileRow,
	type TriggerRow
} from './db/schema';
import { getProfiles, steamEnabled } from './steam';
import { localSignals, orgServers, type LocalSignals } from './players';
import { gateway } from './gateway';
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
	gateway().triggersChanged(server.id);
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
	gateway().triggersChanged(server.id);
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
	gateway().triggersChanged(server.id);
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

// ---- evaluation -----------------------------------------------------------------------------------
// The worker evaluates every enabled trigger against each observation and gets back *intents*:
// actions to take, written to the outbox in the same transaction as the observation (outbox.ts
// delivers them). Evaluation itself makes no game request.

export interface TickContext {
	server: ServerRow;
	status: Status;
	players: Player[];
	/** players with no open session before this observation (empty when joins are not trusted) */
	joined: Player[];
	/** joiners never seen on this server before */
	firstVisit: Set<string>;
	/** SteamIDs with a reserved slot */
	reserved: Set<string>;
	/** pre-fetched for risk rules: the panel's own signals and Steam profiles of the joiners */
	signals: Map<string, LocalSignals>;
	profiles: Map<string, SteamProfileRow>;
	ts: Date;
}

/** One action a rule wants taken; becomes an outbox row. */
export interface Intent {
	trigger: TriggerRow;
	/** a registry action, or "empty_reset" (rotation-aware map reset, resolved at delivery) */
	action: string;
	params: Record<string, unknown>;
	target: string;
	okMessage: string;
	detail: Record<string, unknown>;
	/** only meaningful while this player is on; delivery skips it otherwise */
	steamId: string | null;
	dedupeKey: string;
}

export interface TriggerUpdate {
	id: string;
	lastFiredAt?: Date;
	lastResult?: string;
	state?: unknown;
}

export interface Evaluation {
	intents: Intent[];
	updates: TriggerUpdate[];
}

const vars = (ctx: TickContext, p?: Player) => ({
	name: p?.name ?? '',
	server: ctx.status.serverName || ctx.server.name,
	map: ctx.status.map,
	players: ctx.status.playerCount,
	max: ctx.status.maxPlayers
});

// Enabled triggers per server, cached briefly: the worker asks on every observation.
const ENABLED_TTL_MS = 10_000;
const enabledCache = new Map<string, { until: number; rows: TriggerRow[] }>();

export function invalidateTriggers(serverId?: string): void {
	if (serverId) enabledCache.delete(serverId);
	else enabledCache.clear();
}

export async function enabledTriggers(env: Env, serverId: string): Promise<TriggerRow[]> {
	const hit = enabledCache.get(serverId);
	const now = Date.now();
	if (hit && hit.until > now) return hit.rows;
	const rows = await env.db
		.select()
		.from(triggers)
		.where(and(eq(triggers.serverId, serverId), eq(triggers.enabled, true)));
	enabledCache.set(serverId, { until: now + ENABLED_TTL_MS, rows });
	if (enabledCache.size > 5000)
		for (const [k, v] of enabledCache) if (v.until <= now) enabledCache.delete(k);
	return rows;
}

/** True when any enabled rule needs the risk inputs (so the worker only fetches them then). */
export const needsRiskInputs = (rows: TriggerRow[]): boolean =>
	rows.some((r) => r.kind === 'risk_kick');

/** Evaluates the rules against one observation. Never throws; a broken rule records its error. */
export async function evaluateTriggers(
	env: Env,
	ctx: TickContext,
	rows: TriggerRow[]
): Promise<Evaluation> {
	const out: Evaluation = { intents: [], updates: [] };
	for (const row of rows) {
		try {
			switch (row.kind) {
				case 'welcome':
					evalWelcome(ctx, row, row.config as WelcomeConfig, out);
					break;
				case 'broadcast':
					evalBroadcast(ctx, row, row.config as BroadcastConfig, out);
					break;
				case 'empty_reset':
					await evalEmptyReset(env, ctx, row, row.config as EmptyResetConfig, out);
					break;
				case 'risk_kick':
					evalRiskKick(env, ctx, row, row.config as RiskKickConfig, out);
					break;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[warcon] trigger ${row.name}`, message);
			out.updates.push({ id: row.id, lastResult: `Error: ${message}`.slice(0, 300) });
		}
	}
	return out;
}

const key = (row: TriggerRow, ...parts: (string | number)[]) => [row.id, ...parts].join(':');

function evalWelcome(ctx: TickContext, row: TriggerRow, cfg: WelcomeConfig, out: Evaluation) {
	if (!ctx.joined.length) return;
	let n = 0;
	let last = '';
	for (const p of ctx.joined) {
		if (cfg.onlyFirstVisit && !ctx.firstVisit.has(p.steamId)) continue;
		const message = renderTemplate(cfg.message, vars(ctx, p));
		out.intents.push({
			trigger: row,
			action: 'whisper',
			params: { steamId: p.steamId, message },
			target: p.steamId,
			okMessage: `Whispered ${p.name}.`,
			detail: { name: p.name },
			steamId: p.steamId,
			dedupeKey: key(row, p.steamId, ctx.ts.getTime())
		});
		n++;
		last = p.name;
	}
	if (n)
		out.updates.push({
			id: row.id,
			lastFiredAt: ctx.ts,
			lastResult: `Whispering ${n === 1 ? last : `${n} players`}`
		});
}

function evalBroadcast(ctx: TickContext, row: TriggerRow, cfg: BroadcastConfig, out: Evaluation) {
	if (ctx.status.playerCount < cfg.minPlayers) return;
	const due =
		!row.lastFiredAt || ctx.ts.getTime() - row.lastFiredAt.getTime() >= cfg.everyMinutes * 60_000;
	if (!due) return;
	const state = (row.state as { index?: number } | null) ?? {};
	const index = (state.index ?? 0) % cfg.messages.length;
	const message = renderTemplate(cfg.messages[index], vars(ctx));
	out.intents.push({
		trigger: row,
		action: 'broadcast',
		params: { message },
		target: message,
		okMessage: 'Broadcast sent.',
		detail: { index },
		steamId: null,
		dedupeKey: key(row, ctx.ts.getTime())
	});
	// The row moves on now so the cadence holds even if delivery lags; the result lands later.
	row.lastFiredAt = ctx.ts;
	row.state = { index: index + 1 };
	out.updates.push({
		id: row.id,
		lastFiredAt: ctx.ts,
		lastResult: `Sending: ${message}`,
		state: { index: index + 1 }
	});
}

async function evalEmptyReset(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: EmptyResetConfig,
	out: Evaluation
) {
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
	out.intents.push({
		trigger: row,
		action: 'empty_reset',
		params: {
			map: cfg.map,
			experiences: cfg.experiences,
			lighting: cfg.lighting || undefined,
			zoneAlternator: cfg.zoneAlternator || undefined
		},
		target: cfg.map,
		okMessage: `Reset to ${cfg.map}.`,
		detail: { emptyMinutes: Math.round((ctx.ts.getTime() - since.getTime()) / 60_000) },
		steamId: null,
		dedupeKey: key(row, ctx.ts.getTime())
	});
	row.lastFiredAt = ctx.ts;
	out.updates.push({ id: row.id, lastFiredAt: ctx.ts, lastResult: `Resetting to ${cfg.map}` });
}

function evalRiskKick(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: RiskKickConfig,
	out: Evaluation
) {
	if (!ctx.joined.length) return;
	let n = 0;
	let last = '';
	for (const p of ctx.joined) {
		const l = ctx.signals.get(p.steamId);
		const verdict = riskKickVerdict(cfg, {
			profile: ctx.profiles.get(p.steamId) ?? null,
			steamEnabled: steamEnabled(env),
			bannedOn: l?.bannedOn ?? [],
			watched: l?.watched ?? null,
			reserved: ctx.reserved.has(p.steamId),
			now: ctx.ts
		});
		if (!verdict) continue;
		out.intents.push({
			trigger: row,
			action: 'kick',
			params: { steamId: p.steamId, reason: cfg.reason },
			target: p.steamId,
			okMessage: `Kicked ${p.name}: ${verdict}`,
			detail: { name: p.name, verdict },
			steamId: p.steamId,
			dedupeKey: key(row, p.steamId, ctx.ts.getTime())
		});
		n++;
		last = `${p.name}: ${verdict}`;
	}
	if (n)
		out.updates.push({
			id: row.id,
			lastFiredAt: ctx.ts,
			lastResult: n === 1 ? `Kicking ${last}` : `Kicking ${n} players`
		});
}

/** The risk inputs a risk_kick rule needs for these joiners (DB and Steam; call before the transaction). */
export async function riskInputs(
	env: Env,
	server: ServerRow,
	joined: Player[]
): Promise<{ signals: Map<string, LocalSignals>; profiles: Map<string, SteamProfileRow> }> {
	if (!joined.length) return { signals: new Map(), profiles: new Map() };
	const org = await orgServers(env, server.orgId);
	const [signals, profiles] = await Promise.all([
		localSignals(
			env,
			server.orgId,
			org.map((s) => s.id),
			server.id,
			joined
		),
		steamEnabled(env)
			? getProfiles(
					env,
					joined.map((p) => p.steamId)
				)
			: new Map<string, SteamProfileRow>()
	]);
	return { signals, profiles };
}

/** Records a delivery outcome on the trigger row and in the audit trail. */
export async function recordDelivery(
	env: Env,
	row: { triggerId: string | null; triggerName: string; triggerKind: string; serverId: string },
	server: { id: string; name: string; orgId: string },
	target: string,
	outcome: 'ok' | 'error',
	message: string,
	detail: Record<string, unknown>
): Promise<void> {
	await writeAudit(env, null, {
		actorName: `trigger: ${row.triggerName}`,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'trigger',
		action: `trigger.${row.triggerKind}`,
		target,
		outcome,
		status: outcome === 'ok' ? 200 : 502,
		message,
		detail: { triggerId: row.triggerId, ...detail }
	});
	if (row.triggerId)
		await env.db
			.update(triggers)
			.set({
				lastResult: message.slice(0, 300),
				fireCount: outcome === 'ok' ? sql`${triggers.fireCount} + 1` : undefined
			})
			.where(eq(triggers.id, row.triggerId));
}

// ---- dry run ------------------------------------------------------------------------------------

/** Replays the last 24 hours of this server's history against a rule. Touches nobody. */
export async function dryRun(
	env: Env,
	server: ServerRow,
	kind: TriggerKind,
	rawConfig: unknown,
	readReserved?: () => Promise<string[]>
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
		if (readReserved) {
			try {
				reserved = new Set(await readReserved());
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
