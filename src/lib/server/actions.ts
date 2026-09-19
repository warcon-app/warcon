// The action registry: every game-server operation the panel can perform, with the
// capability it needs (see $lib/capabilities). Routes call `runAction` and audit the result.
import { createHash } from 'node:crypto';
import type { Capability } from '../capabilities';
import { ApiError, int, str } from './http';
import { gamePath } from './hostpolicy';
import { classifyGameError, etagOf, GameError, parseJson, WardogsClient } from './rcon';
import { reservedFromText, reservedIntoText } from '../reserved-doc';
import { hideSecretValues, redactSecrets, restoreSecrets, SECRET_PLACEHOLDER } from '../config-doc';

export interface ActionDef {
	cap: Capability;
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

// `etag`: live builds send the revision as a header too (CL-501228+), a fallback for the body's.
const configResult = (status: number, body: any, etag = '') => ({
	ok: status >= 200 && status < 300 && body.ok !== false,
	status,
	conflict: status === 412,
	revision: body.revision || etag,
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

/** A route this build does not serve: 404 "No such endpoint." (renamed `no_route`) or a 405. */
const isNoRoute = (err: unknown): boolean =>
	err instanceof GameError && (err.code === 'no_route' || err.status === 405);

/**
 * The config document as the game serves it, RCON password and all. For the worker and the edits
 * in this file that write the document back; what a caller is handed is the `config` action's
 * answer, which hides the credentials.
 */
export async function readConfig(c: WardogsClient): Promise<{
	revision: string;
	writable: boolean;
	text: string;
	sections: unknown[];
	warnings: unknown[];
}> {
	// Read raw for the headers: CL-501228 sends the revision as an ETag as well, which
	// covers a build that stops putting it in the body.
	const res = await c.raw('GET', '/v1/config');
	const d = parseJson(res.text) ?? {};
	if (res.status < 200 || res.status >= 300)
		throw classifyGameError('GET', '/v1/config', res.status, res.statusText, d, res.headers);
	const revision = d.revision || etagOf(res.headers);
	// Anything but a document (a proxy page, an empty answer) must never become a writable
	// empty file that the reserved-slot path would then PUT back over the real one.
	if (typeof d.text !== 'string' || !revision || !Array.isArray(d.sections))
		throw new GameError(502, 'The server did not return a config document.', 'bad_response');
	return {
		revision,
		writable: d.writable !== false,
		text: d.text,
		sections: d.sections,
		warnings: d.warnings || []
	};
}

/**
 * A document on its way back to the game: where a credential still reads as the placeholder the
 * caller was shown, the value the server has now goes back in its place.
 */
async function withSecrets(c: WardogsClient, text: unknown): Promise<string> {
	const sent = String(text ?? '');
	if (!sent.includes(SECRET_PLACEHOLDER)) return sent;
	const live = (await readConfig(c)).text;
	try {
		return restoreSecrets(sent, live);
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'Bad document.', 'hidden_value');
	}
}

/**
 * Reserved slots on a build without the live routes (CL-499480 and CL-501228 alike), the way the
 * official console does it: the DefaultReservedPlayerIds array of the config document, edited with
 * the smallest possible change and applied against the revision that was read. Bounded to that one
 * key, which is why `slots.manage` may do it without `config.apply`. The list has no length limit
 * (MaxReservedSlots holds player slots back for its members; it does not cap the list). Error
 * codes match what the live routes and the org list sync expect: 409 `already_reserved`,
 * 404 `reserved_not_found`; a second revision conflict is 412 `revision_conflict`, never a 409.
 */
async function reservedViaConfig(
	c: WardogsClient,
	id: string,
	op: 'add' | 'remove'
): Promise<{ message: string; via: 'config'; revision: string; pendingRestart: boolean }> {
	for (let attempt = 0; ; attempt++) {
		const doc = await readConfig(c);
		if (!doc.writable) {
			throw new GameError(
				400,
				'This server build has no live reserved-slot routes and reports its config document as read-only, so nothing can be reserved from the panel.',
				'config_readonly'
			);
		}
		const ids = reservedFromText(doc.text);
		const present = ids.includes(id);
		if (op === 'add') {
			if (present) {
				throw new GameError(409, `SteamId ${id} is already reserved.`, 'already_reserved');
			}
		} else if (!present) {
			throw new GameError(404, `SteamId ${id} has no reserved slot.`, 'reserved_not_found');
		}
		const next = op === 'add' ? [...ids, id] : ids.filter((x) => x !== id);
		const { status, body, etag } = await c.configCall(
			'PUT',
			'/v1/config',
			reservedIntoText(doc.text, next),
			doc.revision
		);
		const r = configResult(status, body, etag);
		if (r.ok) {
			// Say what actually happened: the document is written, but the running server may not
			// read it until it restarts. The caller sees `pendingRestart` and the message says so.
			const live = await liveReservedIds(c).catch(() => null);
			const pendingRestart = live !== null && live.includes(id) !== (op === 'add');
			const done =
				op === 'add' ? `Reserved a slot for ${id}` : `Removed the reserved slot for ${id}`;
			return {
				message: pendingRestart
					? op === 'add'
						? `${done} in the config document. The running server takes it up when it restarts.`
						: `${done} in the config document. The running server keeps it until it restarts.`
					: `${done}.`,
				via: 'config',
				revision: r.revision,
				pendingRestart
			};
		}
		if (r.conflict) {
			if (attempt === 0) continue;
			throw new GameError(
				412,
				'The config document changed underneath this edit twice; try again.',
				'revision_conflict'
			);
		}
		// Classified like any other refusal (a missing PUT route stays no_route, so the sync never
		// reads it as "already gone") and without the body: a rejected document's error lines can
		// quote the file, which slots.manage alone may not see.
		const e = classifyGameError('PUT', '/v1/config', status, '', body);
		e.body = null;
		e.message = hideSecretValues(e.message, doc.text);
		throw e;
	}
}

/**
 * The running server's reserved list, or null on a build without the read route. Used to check
 * whether a document edit reached the running list: the live builds load DefaultReservedPlayerIds
 * at start, so a slot added or removed through the document reads back unchanged here until the
 * server restarts (seen on a real server 2026-09-15).
 */
async function liveReservedIds(c: WardogsClient): Promise<string[] | null> {
	try {
		return ((await c.json('GET', '/v1/reserved-slots')).reservedSlots || []) as string[];
	} catch (err) {
		if (isNoRoute(err)) return null;
		throw err;
	}
}

/** The live route first (unless the caller knows there is none), the document otherwise. */
async function editReserved(c: WardogsClient, p: any, op: 'add' | 'remove'): Promise<unknown> {
	const id = steamId(p.steamId);
	if (!p.viaConfig) {
		try {
			return op === 'add'
				? await c.json('POST', '/v1/reserved-slots', { steamId: id })
				: await c.json('DELETE', `/v1/reserved-slots/${id}`);
		} catch (err) {
			if (!isNoRoute(err)) throw err;
		}
	}
	return reservedViaConfig(c, id, op);
}

function rotationSettingsOf(p: any): { rotationEnabled?: boolean; rotationMode?: string } {
	const body: { rotationEnabled?: boolean; rotationMode?: string } = {};
	if (p.rotationEnabled !== undefined)
		body.rotationEnabled =
			p.rotationEnabled === true || p.rotationEnabled === 'on' || p.rotationEnabled === 'true';
	if (p.rotationMode !== undefined)
		body.rotationMode = String(p.rotationMode).toLowerCase() === 'random' ? 'random' : 'ordered';
	return body;
}

export const ACTIONS: Record<string, ActionDef> = {
	// ---- reads (viewer) ----
	capabilities: {
		cap: 'server.view',
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
					liveSettings: routes.includes('PATCH /v1/settings'),
					serverId: routes.includes('GET /v1/server-id')
				},
				raw: data
			};
		}
	},
	status: { cap: 'server.view', mutating: false, run: (c, p) => getStatus(c, !!p.raw) },
	// Live build CL-499480: { status, uptimeSeconds, connections:{active}, gameThreadQueue:{inFlight,depth,rejectedTotal} }.
	health: { cap: 'server.view', mutating: false, run: (c) => c.json('GET', '/v1/health') },
	// Live build CL-501228 (2026-09-14): { serverId } is the join code the WARDOGS backend issued; read-only.
	serverId: {
		cap: 'server.view',
		mutating: false,
		run: async (c) => ({ serverId: String((await c.json('GET', '/v1/server-id')).serverId ?? '') })
	},
	players: {
		cap: 'server.view',
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
		cap: 'server.view',
		mutating: false,
		run: async (c) => ({
			maps: ((await c.json('GET', '/v1/catalog/maps')).maps || []).map((m: any) => ({
				id: m.id,
				display: m.displayName || m.id
			}))
		})
	},
	lightings: {
		cap: 'server.view',
		mutating: false,
		run: async (c) => ({
			lightings: ((await c.json('GET', '/v1/catalog/lightings')).lightings || []).map((l: any) => ({
				id: l.id,
				display: l.displayName || l.id
			}))
		})
	},
	experiences: {
		cap: 'server.view',
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
		cap: 'server.view',
		mutating: false,
		run: async (c, p) => ({
			alternators: (
				(await c.json('GET', `/v1/catalog/maps/${encodeURIComponent(str(p.map, 100))}/alternators`))
					.alternators || []
			).map((a: any) => ({ tag: a.tag, display: a.displayName || a.tag }))
		})
	},
	catalog: {
		cap: 'server.view',
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
	rotation: { cap: 'server.view', mutating: false, run: (c) => getRotation(c) },
	bans: {
		cap: 'server.view',
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
	// `document: 1` also reads DefaultReservedPlayerIds from the config document (null when the
	// build has none), so the slots page can show which ids the running server has not caught up
	// with: in the document but not live arrives at restart; live but not in the document leaves.
	reserved: {
		cap: 'server.view',
		mutating: false,
		run: async (c, p) => {
			const reserved = (await c.json('GET', '/v1/reserved-slots')).reservedSlots || [];
			if (!p.document) return { reserved };
			let document: string[] | null = null;
			try {
				document = reservedFromText((await readConfig(c)).text);
			} catch (err) {
				if (!(err instanceof GameError)) throw err;
			}
			return { reserved, document };
		}
	},
	sponsor: {
		cap: 'server.view',
		mutating: false,
		run: async (c) => ({ imageUrl: (await c.json('GET', '/v1/sponsor')).imageUrl || '' })
	},
	// The game's own RCON log: who connected and what they ran. Audit trail, like the panel's
	// record of the same actions. The peer addresses are blanked in rcon-run.ts for everyone but
	// the site owner.
	serverLog: {
		cap: 'audit.read',
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
	// The document without its credentials: the RCON password, its hash and the kill feed token
	// read as a placeholder for everyone, and validate/apply put the live values back. Nobody
	// needs them from here (README, "Roles"). The rest of the document (the join password, the
	// admin list, every setting) is for those who may apply it.
	config: {
		cap: 'config.apply',
		mutating: false,
		run: async (c) => {
			const doc = await readConfig(c);
			return hideSecretValues({ ...doc, text: redactSecrets(doc.text) }, doc.text);
		}
	},

	// ---- operator ----
	broadcast: {
		cap: 'chat.send',
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
		cap: 'chat.send',
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
		cap: 'players.moderate',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) =>
			c.json('POST', `/v1/players/${steamId(p.steamId)}/kick`, {
				reason: str(p.reason, 200) || 'Kicked by admin.'
			})
	},
	kill: {
		cap: 'players.moderate',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => c.json('POST', `/v1/players/${steamId(p.steamId)}/kill`)
	},
	// As the official console does it: move the faction, then kill the player so they respawn on the
	// new side. A failed kill (no living character) is not an error; the move already happened.
	changeTeam: {
		cap: 'players.moderate',
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
	endMatch: { cap: 'match.control', mutating: true, run: (c) => c.json('POST', '/v1/match/end') },
	restartMatch: {
		cap: 'match.control',
		mutating: true,
		run: (c) => c.json('POST', '/v1/match/restart')
	},
	changeMap: {
		cap: 'match.control',
		mutating: true,
		target: (p) => str(p.map, 100),
		run: (c, p) => c.json('POST', '/v1/match/map', mapSelection(p))
	},
	setWeather: {
		cap: 'match.control',
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
		cap: 'match.control',
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
		cap: 'rotation.edit',
		mutating: true,
		target: (p) => str(p.map, 100),
		run: (c, p) => c.json('POST', '/v1/rotation/entries', mapSelection(p))
	},
	rotationRemove: {
		cap: 'rotation.edit',
		mutating: true,
		target: (p) => String(p.index),
		run: (c, p) => c.json('DELETE', `/v1/rotation/entries/${int(p.index, -1, 0, 10000)}`)
	},
	rotationMove: {
		cap: 'rotation.edit',
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
		cap: 'rotation.edit',
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
		cap: 'bans.manage',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) =>
			c.json('POST', '/v1/bans', {
				steamId: steamId(p.steamId),
				reason: str(p.reason, 200) || undefined
			})
	},
	unban: {
		cap: 'bans.manage',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => c.json('DELETE', `/v1/bans/${steamId(p.steamId)}`)
	},
	// Both fall back to the config document on builds without the routes; `viaConfig: true` skips
	// the attempt when the caller already knows (the org list sync, the slots page).
	reservedAdd: {
		cap: 'slots.manage',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => editReserved(c, p, 'add')
	},
	reservedRemove: {
		cap: 'slots.manage',
		mutating: true,
		target: (p) => str(p.steamId, 32),
		run: (c, p) => editReserved(c, p, 'remove')
	},
	rotationSave: {
		cap: 'rotation.save',
		mutating: true,
		run: (c) => c.json('POST', '/v1/rotation/save')
	},
	// Rotation on or off and its order belong with saving the rotation, which is what the
	// capability says and what the rotation page enables the switch on.
	rotationSettings: {
		cap: 'rotation.save',
		mutating: true,
		target: (p) => Object.keys(p || {}).join(','),
		run: (c, p) => {
			const body = rotationSettingsOf(p);
			if (!Object.keys(body).length)
				throw new ApiError(400, 'No settings to apply (rotationEnabled, rotationMode).');
			return c.json('PATCH', '/v1/settings', body);
		}
	},
	settings: {
		cap: 'config.apply',
		mutating: true,
		target: (p) => Object.keys(p || {}).join(','),
		run: (c, p) => {
			const body: any = rotationSettingsOf(p);
			if (p.scoreTick !== undefined) {
				body.scoreTick = int(p.scoreTick, 24, 1, 600);
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
		cap: 'config.apply',
		mutating: false,
		audit: (p) => ({ text: fingerprint(p.text) }),
		run: async (c, p) => {
			const text = await withSecrets(c, p.text);
			const { status, body, etag } = await c.configCall('POST', '/v1/config/validate', text);
			return hideSecretValues(configResult(status, body, etag), text);
		}
	},
	configApply: {
		cap: 'config.apply',
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
			const text = await withSecrets(c, p.text);
			const { status, body, etag } = await c.configCall(
				'PUT',
				path,
				text,
				str(p.revision, 100) || undefined
			);
			const answered = configResult(status, body, etag);
			// A conflict is told as the lines that differ, and the live side of one may be a
			// credential this document never held.
			const live = answered.conflict
				? await readConfig(c)
						.then((d) => d.text)
						.catch(() => '')
				: '';
			const result = hideSecretValues(answered, text, live);
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
		cap: 'rcon.raw',
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
			// The config document carries the RCON password, so it leaves through the config actions,
			// which hide it. What a listener makes of an escape, a ';' or a control character in a
			// route is not something to guess at (%3F, a second layer of %25, a trailing %20), and no
			// /v1 route needs one: the route is plain characters or it is refused. A query may carry
			// escapes.
			const route = path.split('?')[0];
			if (!/^[A-Za-z0-9/_~.-]+$/.test(route))
				throw new ApiError(
					400,
					'A raw path is letters, digits, "/", "-", "_", "." and "~"; put anything else in the query or the body.',
					'bad_path'
				);
			if (/^\/v1\/config(?![a-z0-9_-])/i.test(route))
				throw new ApiError(
					403,
					"The config document is not served through raw: use the 'config', 'configValidate' and 'configApply' actions.",
					'use_config_actions'
				);
			// The listener's log names the address of everyone who connected to it; 'serverLog' serves
			// it, with those addresses for the site owner only.
			if (/^\/v1\/audit(?![a-z0-9_-])/i.test(route))
				throw new ApiError(
					403,
					"The listener's log is not served through raw: use the 'serverLog' action.",
					'use_server_log'
				);
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
			// Only the headers the API documents: a proxy in front of the listener answers with a
			// Location, Via or Alt-Svc that names where RCON listens, and raw is not an owner's tool.
			const headers: Record<string, string> = {};
			for (const name of RAW_HEADERS) if (res.headers[name]) headers[name] = res.headers[name];
			return { status: res.status, headers, body: parsed ?? res.text };
		}
	}
};

const RAW_HEADERS = ['content-type', 'etag', 'retry-after'];

export const ACTION_NAMES = Object.keys(ACTIONS);

/**
 * The action called `name`, or null. The name comes from the request path, so it is looked up as
 * an own property: `constructor`, `toString` and the rest of Object.prototype are not actions.
 */
export const actionDef = (name: string): ActionDef | null =>
	Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
