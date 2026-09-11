// The action registry: every game-server operation the panel can perform, with the
// minimum per-server role it needs. Routes call `runAction` and audit the result.
import { createHash } from 'node:crypto';
import type { ServerRole } from './access';
import { ApiError, int, str } from './http';
import { gamePath } from './hostpolicy';
import { GameError, WardogsClient } from './rcon';

export interface ActionDef {
	level: ServerRole;
	mutating: boolean;
	// What the audit row's target column should hold.
	target?: (p: any) => string;
	/**
	 * What the audit row's detail column keeps instead of the raw params. Set on actions whose
	 * payload can carry credentials (a config document, a raw body); everything else is stored
	 * as sent, redacted by key.
	 */
	audit?: (p: any) => unknown;
	run: (client: WardogsClient, p: any) => Promise<unknown>;
}

/** Length and SHA-256 of a text payload: enough to match an audit row to a document, never the text. */
const fingerprint = (text: unknown) => {
	const s = String(text ?? '');
	return { length: s.length, sha256: createHash('sha256').update(s).digest('hex') };
};

const steamId = (v: unknown): string => {
	const id = str(v, 32);
	if (!/^\d{17}$/.test(id)) {
		throw new ApiError(400, 'steamId must be a 17-digit SteamID64.');
	}
	return id;
};

const mapSelection = (p: any) => {
	const body: any = { map: str(p.map, 100) };
	if (!body.map) {
		throw new ApiError(400, 'map is required.');
	}
	if (Array.isArray(p.experiences) && p.experiences.length) {
		body.experiences = p.experiences.map((e: unknown) => str(e, 100)).filter(Boolean);
	}
	if (p.lighting) {
		body.lighting = str(p.lighting, 100);
	}
	if (p.zoneAlternator && p.zoneAlternator !== 'None') {
		body.zoneAlternator = str(p.zoneAlternator, 200);
	}
	return body;
};

const sameSelection = (entry: any, sel: any) => {
	const key = (v: unknown) => (!v || v === 'None' ? '' : String(v));
	const set = (ids: unknown) => [...((ids as string[]) || [])].sort().join('+');
	return (
		entry.map === sel.map &&
		set(entry.experiences) === set(sel.experiences) &&
		key(entry.lighting) === key(sel.lighting) &&
		key(entry.zoneAlternator) === key(sel.zoneAlternator)
	);
};

async function getRotation(client: WardogsClient) {
	const r = await client.json('GET', '/v1/rotation');
	const entries = (r.entries || []) as any[];
	return {
		enabled: !!r.enabled,
		mode: String(r.mode || 'ordered').toLowerCase(),
		nowIndex: entries.findIndex((e) => e.status === 'now'),
		nextIndex: entries.findIndex((e) => e.status === 'next'),
		entries: entries.map((e) => ({
			map: e.map,
			experiences: e.experiences || [],
			lighting: e.lighting || '',
			zoneAlternator: e.zoneAlternator || '',
			denied: !!e.denied,
			status: e.status || ''
		}))
	};
}

async function getStatus(client: WardogsClient, raw = false) {
	const s = await client.json('GET', '/v1/status');
	const rot = s.rotation || {};
	const idx = (v: unknown) => (v === null || v === undefined ? -1 : Number(v));
	return {
		serverName: s.serverName || '',
		map: s.map || '',
		experiences: s.experiences || [],
		lighting: s.lighting || '',
		alternator: s.alternator || '',
		scoreTick: s.scoreTick?.current ?? null,
		scoreTickMin: s.scoreTick?.min ?? null,
		scoreTickMax: s.scoreTick?.max ?? null,
		scoreCap: s.scoreCap ?? null,
		matchSeconds: s.matchSeconds ?? null,
		playerCount: s.players?.current ?? 0,
		maxPlayers: s.players?.max ?? 0,
		scores: (s.factionScores || []).map((f: any) => ({
			name: f.name,
			colorHex: f.colorHex,
			score: f.score
		})),
		rotationNow: idx(rot.nowIndex),
		rotationNext: idx(rot.nextIndex),
		// Only for the connection test: fields the normaliser does not know (a build may add some).
		...(raw ? { raw: s } : {})
	};
}

const configResult = (status: number, body: any) => ({
	ok: status >= 200 && status < 300 && body.ok !== false,
	status,
	conflict: status === 412,
	revision: body.revision || '',
	errorCode: body.error?.code || '',
	errorMessage:
		body.error?.message || (status >= 200 && status < 300 ? '' : `Request failed (${status}).`),
	outcomes: body.outcomes || [],
	shadowed: body.shadowed || [],
	stripped: body.stripped || [],
	errors: body.errors || [],
	changed: body.changed || [],
	conflictDeltas: body.conflict || [],
	warnings: body.warnings || [],
	timingsMs: body.timingsMs || null
});

export const ACTIONS: Record<string, ActionDef> = {
	// ---- reads (viewer) ----
	capabilities: {
		level: 'viewer',
		mutating: false,
		run: async (c) => {
			const data = await c.json('GET', '/v1/capabilities');
			const norm = (r: unknown) =>
				String(r)
					.trim()
					.replace(/\{[^}]*\}|:[^/\s]+/g, '*')
					.replace(/\s+/g, ' ');
			const routes = (data.routes || []).map(norm);
			return {
				routes: data.routes || [],
				features: {
					changeTeam: routes.includes('PATCH /v1/players/*'),
					configDocument: routes.includes('PUT /v1/config') && !!data.config?.writable,
					reservedSlots: routes.includes('POST /v1/reserved-slots'),
					rotationEdit:
						routes.includes('POST /v1/rotation/entries') &&
						routes.includes('POST /v1/rotation/entries/*/move'),
					rotationSave: routes.includes('POST /v1/rotation/save'),
					liveSettings: routes.includes('PATCH /v1/settings')
				},
				raw: data
			};
		}
	},
	status: { level: 'viewer', mutating: false, run: (c, p) => getStatus(c, !!p.raw) },
	// Live build CL-499480: { status, uptimeSeconds, connections:{active}, gameThreadQueue:{inFlight,depth,rejectedTotal} }.
	health: { level: 'viewer', mutating: false, run: (c) => c.json('GET', '/v1/health') },
	players: {
		level: 'viewer',
		mutating: false,
		run: async (c) => {
			const d = await c.json('GET', '/v1/players');
			// Anything but a list means the answer is not a player list (a proxy page, a half-written
			// response): treating it as "nobody on" would close every session and fire join triggers
			// for everyone on the next poll.
			if (!Array.isArray(d?.players))
				throw new GameError(502, 'The server did not return a player list.', 'bad_response', d);
			return {
				players: d.players.map((p: any) => ({
					name: p.name,
					steamId: p.steamId,
					faction: p.faction ?? null,
					kills: p.kills ?? 0,
					deaths: p.deaths ?? 0,
					cash: p.cash ?? 0,
					ping: p.pingMs ?? p.ping ?? null
				}))
			};
		}
	},
	maps: {
		level: 'viewer',
		mutating: false,
		run: async (c) => ({
			maps: ((await c.json('GET', '/v1/catalog/maps')).maps || []).map((m: any) => ({
				id: m.id,
				display: m.displayName || m.id
			}))
		})
	},
	lightings: {
		level: 'viewer',
		mutating: false,
		run: async (c) => ({
			lightings: ((await c.json('GET', '/v1/catalog/lightings')).lightings || []).map((l: any) => ({
				id: l.id,
				display: l.displayName || l.id
			}))
		})
	},
	experiences: {
		level: 'viewer',
		mutating: false,
		run: async (c, p) => {
			const all = ((await c.json('GET', '/v1/catalog/experiences')).experiences || []).map(
				(e: any) => ({ id: e.id, display: e.displayName || e.id })
			);
			if (!p.map) {
				return { experiences: all };
			}
			const names = new Map(all.map((e: any) => [e.id, e.display]));
			const ids =
				(await c.json('GET', `/v1/catalog/maps/${encodeURIComponent(str(p.map, 100))}/experiences`))
					.experiences || [];
			return { experiences: ids.map((id: string) => ({ id, display: names.get(id) || id })) };
		}
	},
	alternators: {
		level: 'viewer',
		mutating: false,
		run: async (c, p) => ({
			alternators: (
				(await c.json('GET', `/v1/catalog/maps/${encodeURIComponent(str(p.map, 100))}/alternators`))
					.alternators || []
			).map((a: any) => ({ tag: a.tag, display: a.displayName || a.tag }))
		})
	},
	catalog: {
		level: 'viewer',
		mutating: false,
		run: async (c) => {
			const [maps, lightings, experiences] = await Promise.all([
				ACTIONS.maps.run(c, {}),
				ACTIONS.lightings.run(c, {}),
				ACTIONS.experiences.run(c, {})
			]);
			return { ...(maps as object), ...(lightings as object), ...(experiences as object) };
		}
	},
	rotation: { level: 'viewer', mutating: false, run: (c) => getRotation(c) },
	bans: {
		level: 'viewer',
		mutating: false,
		run: async (c) => ({
			bans: ((await c.json('GET', '/v1/bans')).bans || []).map((b: any) => ({
				steamId: b.steamId,
				// Entries loaded from +DefaultBannedPlayerIds carry year 0001 and bannedBy "config".
				bannedAtUtc: /^0001-/.test(b.bannedAtUtc || '') ? '' : b.bannedAtUtc || '',
				bannedBy: b.bannedBy || '',
				reason: b.reason || ''
			}))
		})
	},
	reserved: {
		level: 'viewer',
		mutating: false,
		run: async (c) => ({
			reserved: (await c.json('GET', '/v1/reserved-slots')).reservedSlots || []
		})
	},
	sponsor: {
		level: 'viewer',
		mutating: false,
		run: async (c) => ({ imageUrl: (await c.json('GET', '/v1/sponsor')).imageUrl || '' })
	},
	serverLog: {
		level: 'viewer',
		mutating: false,
		run: async (c, p) => {
			const limit = int(p.limit, 50, 1, 500);
			const d = await c.json('GET', `/v1/audit?limit=${limit}`);
			return {
				entries: (d.entries || []).map((e: any) => ({
					timestampUtc: e.timestampUtc,
					peer: e.peer,
					sessionId: e.sessionId,
					event: e.event,
					detail: e.detail || ''
				}))
			};
		}
	},
	config: {
		level: 'viewer',
		mutating: false,
		run: async (c) => {
			const d = await c.json('GET', '/v1/config');
			return {
				revision: d.revision || '',
				writable: d.writable !== false,
				text: d.text || '',
				sections: d.sections || [],
				warnings: d.warnings || []
			};
		}
	},

	// ---- operator ----
	broadcast: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.message, 200),
		run: (c, p) => {
			const message = str(p.message, 200);
			if (!message) {
				throw new ApiError(400, 'message is required.');
			}
			return c.json('POST', '/v1/broadcast', { message });
		}
	},
	whisper: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => {
			const message = str(p.message, 200);
			if (!message) {
				throw new ApiError(400, 'message is required.');
			}
			return c.json('POST', `/v1/players/${steamId(p.steamId)}/message`, { message });
		}
	},
	kick: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) =>
			c.json('POST', `/v1/players/${steamId(p.steamId)}/kick`, {
				reason: str(p.reason, 200) || 'Kicked by admin.'
			})
	},
	kill: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => c.json('POST', `/v1/players/${steamId(p.steamId)}/kill`)
	},
	// As the official console does it: move the faction, then kill the player so they respawn on the
	// new side. A failed kill (no living character) is not an error; the move already happened.
	changeTeam: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: async (c, p) => {
			const faction = str(p.faction, 100);
			if (!faction) {
				throw new ApiError(400, 'faction is required.');
			}
			const id = steamId(p.steamId);
			const moved = await c.json('PATCH', `/v1/players/${id}`, { faction });
			let respawned = true;
			try {
				await c.json('POST', `/v1/players/${id}/kill`);
			} catch (err) {
				if (!(err instanceof GameError)) throw err;
				respawned = false;
			}
			return {
				...moved,
				respawned,
				message: respawned
					? `Moved to ${faction} and killed, so they respawn on the new side.`
					: `Moved to ${faction}. No living character to kill, so they spawn on the new side.`
			};
		}
	},
	endMatch: { level: 'operator', mutating: true, run: (c) => c.json('POST', '/v1/match/end') },
	restartMatch: {
		level: 'operator',
		mutating: true,
		run: (c) => c.json('POST', '/v1/match/restart')
	},
	changeMap: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.map, 100),
		run: (c, p) => c.json('POST', '/v1/match/map', mapSelection(p))
	},
	setWeather: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.lighting, 100),
		run: (c, p) => {
			const lighting = str(p.lighting, 100);
			if (!lighting) {
				throw new ApiError(400, 'lighting is required.');
			}
			return c.json('PUT', '/v1/world/lighting', { lighting });
		}
	},
	// Same algorithm as the official console: move (or add) the selection into the slot after "now".
	setNextMap: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.map, 100),
		run: async (c, p) => {
			const sel = mapSelection(p);
			const rotation = await getRotation(c);
			const now = rotation.nowIndex;
			let index = rotation.entries.findIndex((e, i) => i !== now && sameSelection(e, sel));
			let nowAfter = now;
			let restLast: number;
			if (index < 0) {
				await c.json('POST', '/v1/rotation/entries', sel);
				index = rotation.entries.length;
				restLast = rotation.entries.length - 1;
			} else {
				if (now > index) {
					nowAfter = now - 1;
				}
				restLast = rotation.entries.length - 2;
			}
			const slot = nowAfter < 0 || nowAfter >= restLast ? 0 : nowAfter + 1;
			if (index !== slot) {
				const direction = slot < index ? 'up' : 'down';
				for (let cur = index; cur !== slot; cur += direction === 'down' ? 1 : -1) {
					await c.json('POST', `/v1/rotation/entries/${cur}/move`, { direction });
				}
			}
			return { message: `Next map set to ${sel.map} (rotation entry ${slot + 1}).` };
		}
	},
	rotationAdd: {
		level: 'operator',
		mutating: true,
		target: (p) => str(p.map, 100),
		run: (c, p) => c.json('POST', '/v1/rotation/entries', mapSelection(p))
	},
	rotationRemove: {
		level: 'operator',
		mutating: true,
		target: (p) => String(p.index),
		run: (c, p) => c.json('DELETE', `/v1/rotation/entries/${int(p.index, -1, 0, 10000)}`)
	},
	rotationMove: {
		level: 'operator',
		mutating: true,
		target: (p) => `${p.index} ${p.direction}`,
		run: (c, p) => {
			const direction = p.direction === 'up' ? 'up' : 'down';
			return c.json('POST', `/v1/rotation/entries/${int(p.index, -1, 0, 10000)}/move`, {
				direction
			});
		}
	},
	rotationReorder: {
		level: 'operator',
		mutating: true,
		target: (p) => `${p.from} -> ${p.to}`,
		run: async (c, p) => {
			const from = int(p.from, -1, 0, 10000);
			const to = int(p.to, -1, 0, 10000);
			if (from < 0 || to < 0) {
				throw new ApiError(400, 'from and to are required.');
			}
			const direction = to < from ? 'up' : 'down';
			for (let cur = from; cur !== to; cur += direction === 'down' ? 1 : -1) {
				await c.json('POST', `/v1/rotation/entries/${cur}/move`, { direction });
			}
			return { message: `Moved rotation entry ${from + 1} to position ${to + 1}.` };
		}
	},

	// ---- admin ----
	ban: {
		level: 'admin',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) =>
			c.json('POST', '/v1/bans', {
				steamId: steamId(p.steamId),
				reason: str(p.reason, 200) || undefined
			})
	},
	unban: {
		level: 'admin',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => c.json('DELETE', `/v1/bans/${steamId(p.steamId)}`)
	},
	reservedAdd: {
		level: 'admin',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => c.json('POST', '/v1/reserved-slots', { steamId: steamId(p.steamId) })
	},
	reservedRemove: {
		level: 'admin',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => c.json('DELETE', `/v1/reserved-slots/${steamId(p.steamId)}`)
	},
	rotationSave: { level: 'admin', mutating: true, run: (c) => c.json('POST', '/v1/rotation/save') },
	settings: {
		level: 'admin',
		mutating: true,
		target: (p) => Object.keys(p || {}).join(','),
		run: (c, p) => {
			const body: any = {};
			if (p.scoreTick !== undefined) {
				body.scoreTick = int(p.scoreTick, 24, 1, 600);
			}
			if (p.rotationEnabled !== undefined) {
				body.rotationEnabled =
					p.rotationEnabled === true || p.rotationEnabled === 'on' || p.rotationEnabled === 'true';
			}
			if (p.rotationMode !== undefined) {
				body.rotationMode =
					String(p.rotationMode).toLowerCase() === 'random' ? 'random' : 'ordered';
			}
			if (!Object.keys(body).length) {
				throw new ApiError(400, 'No settings to apply (scoreTick, rotationEnabled, rotationMode).');
			}
			return c.json('PATCH', '/v1/settings', body);
		}
	},
	// There is no live route for the sponsor image any more: real listeners answer PUT /v1/sponsor
	// with "PUT is not supported on this endpoint", and the official console only ever writes
	// ServerImageURL through the config document (PUT /v1/config). Warcon does the same.
	configValidate: {
		level: 'admin',
		mutating: false,
		audit: (p) => ({ text: fingerprint(p.text) }),
		run: async (c, p) => {
			const { status, body } = await c.configCall(
				'POST',
				'/v1/config/validate',
				String(p.text ?? '')
			);
			return configResult(status, body);
		}
	},
	configApply: {
		level: 'admin',
		mutating: true,
		target: (p) => str(p.revision, 100),
		// The document itself holds Password= / ServerPassword= lines; the trail keeps its fingerprint.
		audit: (p) => ({
			text: fingerprint(p.text),
			revision: str(p.revision, 100),
			force: !!p.force,
			fullApply: !!p.fullApply
		}),
		run: async (c, p) => {
			const query: string[] = [];
			if (p.force) {
				query.push('force=true');
			}
			if (p.fullApply) {
				query.push('fullApply=true');
			}
			const path = '/v1/config' + (query.length ? `?${query.join('&')}` : '');
			const { status, body } = await c.configCall(
				'PUT',
				path,
				String(p.text ?? ''),
				str(p.revision, 100) || undefined
			);
			const result = configResult(status, body);
			if (!result.ok && !result.conflict) {
				throw new GameError(
					status,
					result.errorMessage || 'Config apply failed.',
					result.errorCode,
					result
				);
			}
			return result;
		}
	},
	// Escape hatch for routes this panel does not model yet. Admin only, /v1 only, fully audited.
	raw: {
		level: 'admin',
		mutating: true,
		target: (p) => `${str(p.method, 10).toUpperCase()} ${str(p.path, 300)}`,
		// Text bodies (config documents) are fingerprinted; JSON bodies are kept, redacted by key and line.
		audit: (p) => ({
			method: str(p.method, 10).toUpperCase(),
			path: str(p.path, 500),
			body: typeof p.body === 'string' ? fingerprint(p.body) : p.body
		}),
		run: async (c, p) => {
			const method = str(p.method, 10).toUpperCase();
			if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
				throw new ApiError(400, 'Unsupported method.');
			}
			// Parsed and re-serialised first: "%2e%2e" is a dot segment to a URL parser.
			const path = gamePath(str(p.path, 500));
			const isText = typeof p.body === 'string';
			const res = await c.raw(
				method,
				path,
				p.body === undefined ? undefined : isText ? p.body : JSON.stringify(p.body),
				p.body === undefined ? {} : { 'Content-Type': isText ? 'text/plain' : 'application/json' }
			);
			let parsed: any = null;
			try {
				parsed = JSON.parse(res.text);
			} catch {
				parsed = null;
			}
			return { status: res.status, headers: res.headers, body: parsed ?? res.text };
		}
	}
};

export const ACTION_NAMES = Object.keys(ACTIONS);
