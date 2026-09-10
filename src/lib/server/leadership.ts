// Which process owns observation and delivery. One row in worker_ownership holds a token and a
// lease; the owner renews it every few seconds, and any other process takes over once the lease
// has lapsed. Every worker write runs through withOwnedTransaction, which re-checks the token
// inside the transaction (FOR SHARE), so a worker that lost the lease can never write late.
import { eq, sql } from 'drizzle-orm';
import type { Env } from './env';
import type { Tx } from './db';
import { workerOwnership } from './db/schema';

const ROW_ID = 1;
export const LEASE_MS = 15_000;

const token = crypto.randomUUID();
let owner = false;
let since = 0;
let lastRenewAt = 0;

export class LostOwnership extends Error {
	constructor() {
		super('This process no longer owns the worker lease.');
	}
}

/** Takes the lease if it is free or ours; renews it if ours. Returns whether we own it now. */
export async function acquireOrRenew(env: Env, label: string): Promise<boolean> {
	const until = new Date(Date.now() + LEASE_MS);
	const rows = await env.db
		.insert(workerOwnership)
		.values({ id: ROW_ID, token, label, leaseUntil: until })
		.onConflictDoUpdate({
			target: workerOwnership.id,
			set: {
				token,
				label,
				leaseUntil: until,
				acquiredAt: sql`CASE WHEN ${workerOwnership.token} = ${token} THEN ${workerOwnership.acquiredAt} ELSE now() END`
			},
			setWhere: sql`${workerOwnership.token} = ${token} OR ${workerOwnership.leaseUntil} < now()`
		})
		.returning({ token: workerOwnership.token, acquiredAt: workerOwnership.acquiredAt });
	const now = !!rows.length && rows[0].token === token;
	if (now) {
		// acquired_at is reset whenever the token changed hands, even if we never saw the loss.
		const period = rows[0].acquiredAt.getTime();
		if (!owner || period !== since) console.log(`[warcon] this process owns the worker (${label})`);
		since = period;
	}
	if (!now && owner) console.warn('[warcon] lost the worker lease; another process owns it');
	owner = now;
	if (now) lastRenewAt = Date.now();
	return owner;
}

/** Gives the lease up cleanly (shutdown), so the next process need not wait for it to lapse. */
export async function releaseOwnership(env: Env): Promise<void> {
	if (!owner) return;
	owner = false;
	await env.db
		.update(workerOwnership)
		.set({ leaseUntil: new Date(0) })
		.where(eq(workerOwnership.token, token))
		.catch(() => {});
}

/** Owner, and the last renewal landed within the lease: a stalled renewal is a lost lease. */
export const isOwner = (): boolean => owner && Date.now() - lastRenewAt < LEASE_MS;
export const ownershipStats = () => ({ owner, token: token.slice(0, 8), since, lastRenewAt });

/** A transaction that aborts unless this process still holds the lease at commit time. */
export async function withOwnedTransaction<T>(env: Env, fn: (tx: Tx) => Promise<T>): Promise<T> {
	if (!owner) throw new LostOwnership();
	return env.db.transaction(async (tx) => {
		const [row] = await tx
			.select({ token: workerOwnership.token, leaseUntil: workerOwnership.leaseUntil })
			.from(workerOwnership)
			.where(eq(workerOwnership.id, ROW_ID))
			.for('share');
		if (!row || row.token !== token || row.leaseUntil.getTime() < Date.now()) {
			owner = false;
			throw new LostOwnership();
		}
		return fn(tx);
	});
}
