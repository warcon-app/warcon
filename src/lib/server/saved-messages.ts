// The org's saved messages ($lib/saved-messages): read for whoever may chat on one of its servers,
// saved whole by an owner. The worker never reads them.
import { eq } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { orgSavedMessages, user } from './db/schema';
import {
	cleanSavedMessage,
	savedMessagesProblem,
	storedSavedMessages,
	type SavedMessage
} from '$lib/saved-messages';

/** The org's saved messages, in order; none until its owners save some. */
export async function savedMessagesFor(env: Env, orgId: string): Promise<SavedMessage[]> {
	const [row] = await env.db
		.select({ messages: orgSavedMessages.messages })
		.from(orgSavedMessages)
		.where(eq(orgSavedMessages.orgId, orgId))
		.limit(1);
	return row ? storedSavedMessages(row.messages) : [];
}

export interface SavedMessagesView {
	savedMessages: SavedMessage[];
	/** when they were last saved, and by whom (null once that account is deleted) */
	savedAt: string | null;
	savedBy: string | null;
}

/** What the owners' editor shows: the list, and when and by whom it was last saved. */
export async function savedMessagesView(env: Env, orgId: string): Promise<SavedMessagesView> {
	const [row] = await env.db
		.select({
			messages: orgSavedMessages.messages,
			updatedAt: orgSavedMessages.updatedAt,
			username: user.username
		})
		.from(orgSavedMessages)
		.leftJoin(user, eq(user.id, orgSavedMessages.updatedBy))
		.where(eq(orgSavedMessages.orgId, orgId))
		.limit(1);
	return {
		savedMessages: row ? storedSavedMessages(row.messages) : [],
		savedAt: row ? row.updatedAt.toISOString() : null,
		savedBy: row?.username ?? null
	};
}

/**
 * Owners: the messages offered to everyone who may chat on the org's servers, in order. Saved
 * whole; a message already sent is not touched.
 */
export async function setSavedMessages(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	value: unknown
): Promise<SavedMessage[]> {
	if (!Array.isArray(value)) throw new ApiError(400, 'Send the saved messages as a list.');
	const messages = value.map(cleanSavedMessage);
	const problem = savedMessagesProblem(messages);
	if (problem) throw new ApiError(400, problem);
	const at = new Date();
	await env.db
		.insert(orgSavedMessages)
		.values({ orgId: org.id, messages, updatedAt: at, updatedBy: actor.id })
		.onConflictDoUpdate({
			target: orgSavedMessages.orgId,
			set: { messages, updatedAt: at, updatedBy: actor.id }
		});
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.saved_messages',
		outcome: 'ok',
		target: org.name,
		message: 'Saved messages changed',
		detail: { orgId: org.id, savedMessages: messages }
	});
	return messages;
}
