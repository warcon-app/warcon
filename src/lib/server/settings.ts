// Runtime settings the site owner may change without a deploy: observation cadences, budgets,
// retention. Stored in site_settings (key + JSON), bounds enforced here, audited by the caller,
// re-read by the worker every few seconds. Env vars only seed the defaults on a fresh install.
import { eq } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError } from './http';
import { siteSettings } from './db/schema';

export interface SettingSpec {
	label: string;
	help: string;
	unit: 'ms' | 'count' | 'days';
	default: number;
	min: number;
	max: number;
	group: 'observation' | 'delivery' | 'housekeeping';
}

export const SETTINGS = {
	watchedPlayersMs: {
		label: 'Watched: players',
		help: 'How often the player list is read while someone has the server open.',
		unit: 'ms',
		default: 1000,
		min: 500,
		max: 60_000,
		group: 'observation'
	},
	watchedStatusMs: {
		label: 'Watched: status',
		help: 'How often status (scores, map, clock) is read while someone has the server open.',
		unit: 'ms',
		default: 2000,
		min: 1000,
		max: 60_000,
		group: 'observation'
	},
	hotPlayersMs: {
		label: 'Busy: players',
		help: 'Player list cadence on a server with people on it and nobody watching. Sets how fast joins are noticed.',
		unit: 'ms',
		default: 2000,
		min: 1000,
		max: 120_000,
		group: 'observation'
	},
	hotStatusMs: {
		label: 'Busy: status',
		help: 'Status cadence on a server with people on it and nobody watching.',
		unit: 'ms',
		default: 5000,
		min: 1000,
		max: 120_000,
		group: 'observation'
	},
	idleMs: {
		label: 'Empty server',
		help: 'Cadence for a server with nobody on it. The first join is noticed within this.',
		unit: 'ms',
		default: 30_000,
		min: 5000,
		max: 600_000,
		group: 'observation'
	},
	offlineMs: {
		label: 'Unreachable: first retry',
		help: 'Cadence once a server has stopped answering; doubles on every further failure.',
		unit: 'ms',
		default: 30_000,
		min: 5000,
		max: 600_000,
		group: 'observation'
	},
	offlineMaxMs: {
		label: 'Unreachable: longest wait',
		help: 'The retry cadence never grows past this.',
		unit: 'ms',
		default: 120_000,
		min: 5000,
		max: 3_600_000,
		group: 'observation'
	},
	watchLeaseMs: {
		label: 'Watch lease',
		help: 'How long a server stays in the watched tier after the last browser stopped looking.',
		unit: 'ms',
		default: 15_000,
		min: 5000,
		max: 120_000,
		group: 'observation'
	},
	concurrency: {
		label: 'Observations in flight',
		help: 'Servers the worker may be talking to at once. A guard for the process, not a cadence; keep under 256.',
		unit: 'count',
		default: 128,
		min: 1,
		max: 1024,
		group: 'observation'
	},
	sampleMs: {
		label: 'Analytics heartbeat',
		help: 'A sample row is written when something changed, and at least this often while a server is up.',
		unit: 'ms',
		default: 20_000,
		min: 5000,
		max: 300_000,
		group: 'housekeeping'
	},
	sessionHeartbeatMs: {
		label: 'Session heartbeat',
		help: 'How often open sessions get their last-seen time and stats written to the database.',
		unit: 'ms',
		default: 30_000,
		min: 5000,
		max: 300_000,
		group: 'housekeeping'
	},
	listsSnapshotMs: {
		label: 'Ban list snapshot',
		help: 'How often each server’s ban list and reserved slots are re-read.',
		unit: 'ms',
		default: 300_000,
		min: 30_000,
		max: 3_600_000,
		group: 'housekeeping'
	},
	listSyncMs: {
		label: 'Org list sync',
		help: 'How often the organisation’s ban and reserved lists are re-applied to each server.',
		unit: 'ms',
		default: 60_000,
		min: 10_000,
		max: 3_600_000,
		group: 'housekeeping'
	},
	outboxLeaseMs: {
		label: 'Delivery lease',
		help: 'How long a claimed trigger action may take before another pass may pick it up.',
		unit: 'ms',
		default: 45_000,
		min: 5000,
		max: 300_000,
		group: 'delivery'
	},
	outboxMaxAgeMs: {
		label: 'Stale action cut-off',
		help: 'A trigger action older than this is skipped instead of sent (a welcome two minutes late is noise).',
		unit: 'ms',
		default: 120_000,
		min: 10_000,
		max: 3_600_000,
		group: 'delivery'
	},
	rawRetentionDays: {
		label: 'Raw samples kept',
		help: 'Days of per-observation samples to keep; charts beyond this use the hourly rollups.',
		unit: 'days',
		default: 14,
		min: 1,
		max: 365,
		group: 'housekeeping'
	},
	sessionRetentionDays: {
		label: 'Sessions and matches kept',
		help: 'Days of player sessions and match history to keep.',
		unit: 'days',
		default: 365,
		min: 7,
		max: 3650,
		group: 'housekeeping'
	}
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = { [K in SettingKey]: number };
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

const clamp = (key: SettingKey, v: number) =>
	Math.min(SETTINGS[key].max, Math.max(SETTINGS[key].min, Math.round(v)));

function defaults(env?: Pick<Env, 'POLL_SECONDS' | 'POLL_CONCURRENCY'>): Settings {
	const out = {} as Settings;
	for (const k of SETTING_KEYS) out[k] = SETTINGS[k].default;
	// Legacy env seeds, honoured only until the owner saves a value.
	const poll = Number(env?.POLL_SECONDS);
	if (Number.isFinite(poll) && poll > 0) out.sampleMs = clamp('sampleMs', poll * 1000);
	const conc = Number(env?.POLL_CONCURRENCY);
	if (Number.isInteger(conc) && conc > 0) out.concurrency = clamp('concurrency', conc);
	return out;
}

let current: Settings = defaults();
let version = 0;

/** The effective settings right now (synchronous; loadSettings keeps it fresh). */
export const settings = (): Settings => current;
/** Bumps whenever the effective values change; the worker watches it to re-plan cadences. */
export const settingsVersion = (): number => version;

/** Reads the table over the defaults. Called at startup and by the worker every few seconds. */
export async function loadSettings(env: Env): Promise<Settings> {
	const rows = await env.db.select().from(siteSettings);
	const next = defaults(env);
	for (const r of rows) {
		const key = r.key as SettingKey;
		if (!(key in SETTINGS)) continue;
		const raw = r.value as { n?: unknown } | number | string | null;
		const v = Number(raw && typeof raw === 'object' ? raw.n : raw);
		if (Number.isFinite(v)) next[key] = clamp(key, v);
	}
	if (SETTING_KEYS.some((k) => next[k] !== current[k])) version++;
	current = next;
	return current;
}

/** Validates and stores a partial update; returns the keys that changed. Throws 400 on bad input. */
export async function saveSettings(
	env: Env,
	patch: Record<string, unknown>,
	updatedBy: string | null
): Promise<{ settings: Settings; changed: Partial<Settings> }> {
	await loadSettings(env); // compare against what is stored, not this process's cache
	const problems: string[] = [];
	const updates: Partial<Settings> = {};
	for (const [k, raw] of Object.entries(patch)) {
		if (!(k in SETTINGS)) {
			problems.push(`Unknown setting '${k}'.`);
			continue;
		}
		const key = k as SettingKey;
		const v = Number(raw);
		const spec = SETTINGS[key];
		if (!Number.isFinite(v) || v < spec.min || v > spec.max) {
			problems.push(`${spec.label} must be between ${spec.min} and ${spec.max} ${spec.unit}.`);
			continue;
		}
		const value = Math.round(v);
		if (value !== current[key]) updates[key] = value;
	}
	if (problems.length) throw new ApiError(400, problems.join(' '), 'bad_setting');
	const now = new Date();
	for (const [k, n] of Object.entries(updates)) {
		const value = { n };
		await env.db
			.insert(siteSettings)
			.values({ key: k, value, updatedAt: now, updatedBy })
			.onConflictDoUpdate({
				target: siteSettings.key,
				set: { value, updatedAt: now, updatedBy }
			});
	}
	if (Object.keys(updates).length) {
		current = { ...current, ...updates };
		version++;
	}
	return { settings: current, changed: updates };
}

/** Resets a key to its default (removes the stored row). */
export async function resetSetting(env: Env, key: string): Promise<void> {
	if (!(key in SETTINGS)) throw new ApiError(400, `Unknown setting '${key}'.`, 'bad_setting');
	await env.db.delete(siteSettings).where(eq(siteSettings.key, key));
	await loadSettings(env);
}

export interface SettingView extends SettingSpec {
	key: SettingKey;
	value: number;
	stored: boolean;
}

/** Every setting with its effective value, for the owner's settings page. */
export async function settingsView(env: Env): Promise<SettingView[]> {
	await loadSettings(env);
	const stored = new Set(
		(await env.db.select({ key: siteSettings.key }).from(siteSettings)).map((r) => r.key)
	);
	return SETTING_KEYS.map((key) => ({
		key,
		...SETTINGS[key],
		value: current[key],
		stored: stored.has(key)
	}));
}
