// Self-service account deletion (the GDPR right to erasure). Better Auth's delete-user endpoint
// removes the account itself and the schema cascades sessions, credentials, grants and org
// memberships. These two hooks, wired into auth.ts, decide whether a deletion may go ahead and
// scrub what the cascade leaves behind.
import { and, count, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { APIError } from 'better-auth/api';
import type { Env } from './env';
import { writeAudit } from './audit';
import { auditLog, listEntries, user } from './db/schema';
import { soleOwnerOf } from './orgs';

/** What a deleted account's name becomes in the audit trail. */
export const DELETED_ACTOR = '[deleted]';

type DeletingUser = { id: string; role?: string | null; username?: string | null; name?: string };

const refuse = (message: string) =>
	APIError.from('BAD_REQUEST', { code: 'CANNOT_DELETE_ACCOUNT', message });

/** The panel must keep a site owner, and every organisation must keep an owner. */
export async function assertMayDeleteSelf(env: Env, u: DeletingUser): Promise<void> {
	if (u.role === 'owner') {
		const [row] = await env.db
			.select({ n: count() })
			.from(user)
			.where(
				and(
					eq(user.role, 'owner'),
					ne(user.id, u.id),
					or(isNull(user.banned), eq(user.banned, false))
				)
			);
		if (!(row?.n ?? 0))
			throw refuse('You are the only site owner. Promote another owner on the Users page first.');
	}
	const sole = await soleOwnerOf(env, u.id);
	if (sole.length)
		throw refuse(
			`You are the only owner of ${sole.join(', ')}. Promote another owner there, or delete the organisation, first.`
		);
}

/**
 * Pseudonymises the audit trail after the account row is gone. Rows the person wrote keep their
 * opaque actor id (so the trail still hangs together) but lose name, IP address and user agent;
 * rows about the person (user, org and sign-in events that name them) lose the username.
 */
export async function eraseUserTraces(env: Env, u: DeletingUser): Promise<void> {
	await env.db.transaction(async (tx) => {
		await tx
			.update(auditLog)
			.set({ actorName: DELETED_ACTOR, ip: '', userAgent: '' })
			.where(eq(auditLog.actorId, u.id));
		const username = (u.username || u.name || '').toLowerCase();
		if (username)
			await tx
				.update(auditLog)
				.set({ target: DELETED_ACTOR })
				.where(
					and(
						inArray(auditLog.category, ['auth', 'user', 'org']),
						sql`lower(${auditLog.target}) = ${username}`
					)
				);
		// Org list entries keep their opaque ids too; only the names go.
		await tx
			.update(listEntries)
			.set({ addedByName: DELETED_ACTOR })
			.where(eq(listEntries.addedBy, u.id));
		await tx
			.update(listEntries)
			.set({ removedByName: DELETED_ACTOR })
			.where(eq(listEntries.removedBy, u.id));
	});
}

/**
 * Records the deletion itself, keeping the requester's IP as evidence that they asked for it.
 * The account page calls this with its request; the afterDelete hook only has one when the
 * Better Auth endpoint was posted to directly, and skips it otherwise so the row is written once.
 */
export async function auditSelfDelete(env: Env, req: Request | null, u: DeletingUser) {
	await writeAudit(env, req, {
		actor: { id: u.id, username: DELETED_ACTOR },
		category: 'user',
		action: 'account.delete',
		outcome: 'ok',
		message: 'Deleted by the account holder'
	});
}
