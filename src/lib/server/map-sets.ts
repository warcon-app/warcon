// The org's map sets ($lib/map-sets): read for whoever may apply the config of one of its servers,
// saved, renamed and deleted by its owners. The worker never reads them, and nothing here reaches
// a game server: loading a set is the Map rotation tab's own config apply.
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, newId } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { orgMapSets, user } from './db/schema';
import {
	cleanMapSetEntries,
	cleanMapSetName,
	MAX_MAP_SETS,
	storedMapSetEntries,
	type MapSet
} from '$lib/map-sets';
import type { MapSelection } from '$lib/types';

const byName = [asc(sql`lower(${orgMapSets.name})`), asc(orgMapSets.id)];

/** The org's map sets, by name; none until its owners save one. */
export async function mapSetsFor(env: Env, orgId: string): Promise<MapSet[]> {
	const rows = await env.db
		.select({ id: orgMapSets.id, name: orgMapSets.name, entries: orgMapSets.entries })
		.from(orgMapSets)
		.where(eq(orgMapSets.orgId, orgId))
		.orderBy(...byName);
	return rows.map((r) => ({ id: r.id, name: r.name, entries: storedMapSetEntries(r.entries) }));
}

export interface MapSetView extends MapSet {
	/** when it was last saved, and by whom (null once that account is deleted) */
	savedAt: string;
	savedBy: string | null;
}

/** What the owners' tab shows: each set, and when and by whom it was last saved. */
export async function mapSetsView(env: Env, orgId: string): Promise<MapSetView[]> {
	const rows = await env.db
		.select({
			id: orgMapSets.id,
			name: orgMapSets.name,
			entries: orgMapSets.entries,
			updatedAt: orgMapSets.updatedAt,
			username: user.username
		})
		.from(orgMapSets)
		.leftJoin(user, eq(user.id, orgMapSets.updatedBy))
		.where(eq(orgMapSets.orgId, orgId))
		.orderBy(...byName);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		entries: storedMapSetEntries(r.entries),
		savedAt: r.updatedAt.toISOString(),
		savedBy: r.username ?? null
	}));
}

function nameOf(value: unknown): string {
	const name = cleanMapSetName(value);
	if (!name) throw new ApiError(400, 'Give the map set a name.');
	return name;
}

function entriesOf(value: unknown): MapSelection[] {
	const entries = cleanMapSetEntries(value);
	if (typeof entries === 'string') throw new ApiError(400, entries);
	return entries;
}

/** Another of the org's map sets has the name: its unique index refused the write. */
const nameTaken = (err: unknown): boolean => {
	const cause = (err as { cause?: { errno?: unknown; constraint?: unknown } })?.cause;
	return cause?.errno === '23505' && cause.constraint === 'org_map_sets_org_name_uidx';
};
const takenError = (name: string) =>
	new ApiError(409, `There is a map set called ${name} already.`, 'name_taken');

async function ownMapSet(env: Env, org: OrgRow, setId: string) {
	const [row] = await env.db
		.select()
		.from(orgMapSets)
		.where(and(eq(orgMapSets.id, setId), eq(orgMapSets.orgId, org.id)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Map set not found.', 'not_found');
	return row;
}

const entriesNote = (n: number) => `${n} rotation ${n === 1 ? 'entry' : 'entries'}`;

/** Owners: a new map set, {name, entries}. */
export async function createMapSet(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<MapSet> {
	const name = nameOf(body.name);
	const entries = entriesOf(body.entries);
	const [{ n }] = await env.db
		.select({ n: count() })
		.from(orgMapSets)
		.where(eq(orgMapSets.orgId, org.id));
	if (n >= MAX_MAP_SETS)
		throw new ApiError(400, `An organisation keeps at most ${MAX_MAP_SETS} map sets.`);
	const id = newId();
	try {
		await env.db
			.insert(orgMapSets)
			.values({ id, orgId: org.id, name, entries, updatedAt: new Date(), updatedBy: actor.id });
	} catch (err) {
		if (nameTaken(err)) throw takenError(name);
		throw err;
	}
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'map_set.create',
		outcome: 'ok',
		target: name,
		message: `Map set saved: ${entriesNote(entries.length)}`,
		detail: { orgId: org.id, mapSetId: id, entries: entries.length }
	});
	return { id, name, entries };
}

/** Owners: {name?, entries?}, a new name, new entries, or both. */
export async function updateMapSet(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	setId: string,
	body: Record<string, unknown>
): Promise<MapSet> {
	const row = await ownMapSet(env, org, setId);
	if (body.name === undefined && body.entries === undefined)
		throw new ApiError(400, 'Nothing to update.');
	const name = body.name === undefined ? row.name : nameOf(body.name);
	const entries =
		body.entries === undefined ? storedMapSetEntries(row.entries) : entriesOf(body.entries);
	let written: { id: string }[];
	try {
		written = await env.db
			.update(orgMapSets)
			.set({ name, entries, updatedAt: new Date(), updatedBy: actor.id })
			.where(eq(orgMapSets.id, row.id))
			.returning({ id: orgMapSets.id });
	} catch (err) {
		if (nameTaken(err)) throw takenError(name);
		throw err;
	}
	if (!written.length) throw new ApiError(404, 'Map set not found.', 'not_found');
	const detail: Record<string, unknown> = { orgId: org.id, mapSetId: row.id };
	if (name !== row.name) detail.from = row.name;
	if (body.entries !== undefined) detail.entries = entries.length;
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'map_set.update',
		outcome: 'ok',
		target: name,
		message:
			body.entries !== undefined
				? `Map set saved: ${entriesNote(entries.length)}`
				: name !== row.name
					? `Map set renamed from ${row.name}`
					: 'Map set saved',
		detail
	});
	return { id: row.id, name, entries };
}

/** Owners: a map set gone. A server it was loaded on keeps its rotation. */
export async function deleteMapSet(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	setId: string
): Promise<void> {
	const row = await ownMapSet(env, org, setId);
	const gone = await env.db
		.delete(orgMapSets)
		.where(eq(orgMapSets.id, row.id))
		.returning({ id: orgMapSets.id });
	if (!gone.length) throw new ApiError(404, 'Map set not found.', 'not_found');
	const n = storedMapSetEntries(row.entries).length;
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'map_set.delete',
		outcome: 'ok',
		target: row.name,
		message: `Map set deleted: it had ${entriesNote(n)}`,
		detail: { orgId: org.id, mapSetId: row.id, entries: n }
	});
}
