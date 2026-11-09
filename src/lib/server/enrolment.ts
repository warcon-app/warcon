// What sign-in methods an account holds, and whether that satisfies the rules in $lib/enrolment.
// The verdict is cached on user.auth_complete so the request hook needs no extra query; call
// refreshAuthComplete after anything that adds or removes a method.
import { and, count, eq, isNull, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { forLog } from './http';
import { account, orgMembers, orgRoles, passkey, serverGrants, user } from './db/schema';
import { AUTH_ENFORCE, settings } from './settings';
import type { Capability } from '$lib/capabilities';
import {
	assessEnrolment,
	enrolmentStatus,
	type AuthMethods,
	type Enrolment,
	type EnrolmentStatus,
	type EnrolmentSubject
} from '$lib/enrolment';

export async function authMethodsFor(env: Env, userId: string): Promise<AuthMethods> {
	const [providers, [pk], [u]] = await Promise.all([
		env.db
			.select({ providerId: account.providerId })
			.from(account)
			.where(eq(account.userId, userId)),
		env.db.select({ n: count() }).from(passkey).where(eq(passkey.userId, userId)),
		env.db
			.select({ twoFactorEnabled: user.twoFactorEnabled, recoveryKeyHash: user.recoveryKeyHash })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1)
	]);
	const list = providers.map((p) => p.providerId);
	return {
		password: list.includes('credential'),
		twoFactor: !!u?.twoFactorEnabled,
		passkeys: pk?.n ?? 0,
		providers: list,
		recoveryKey: !!u?.recoveryKeyHash
	};
}

export interface EnrolmentView {
	methods: AuthMethods;
	enrolment: Enrolment;
}

/** Re-evaluates the rules for one account and stores the verdict. */
export async function refreshAuthComplete(env: Env, userId: string): Promise<EnrolmentView> {
	const [row] = await env.db
		.select({ role: user.role, authComplete: user.authComplete })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	const methods = await authMethodsFor(env, userId);
	const enrolment = assessEnrolment(methods, row?.role === 'owner' ? 'owner' : 'member');
	if (row && row.authComplete !== enrolment.complete)
		await env.db.update(user).set({ authComplete: enrolment.complete }).where(eq(user.id, userId));
	return { methods, enrolment };
}

/**
 * The grace period counts from the first sign-in after the rules arrived. A later sign-in leaves
 * the clock alone: signing out and in again must not buy another period.
 */
export async function startGrace(env: Env, userId: string): Promise<void> {
	await env.db
		.update(user)
		.set({ authGraceStartedAt: new Date() })
		.where(and(eq(user.id, userId), isNull(user.authGraceStartedAt)))
		.then(() => {})
		.catch((err) => console.error('enrolment grace', forLog(err)));
}

export const statusFor = (u: EnrolmentSubject): EnrolmentStatus => enrolmentStatus(u, settings());

/** Server capabilities that make an account worth protecting: it can hurt a server or its players. */
export const PRIVILEGED_CAPS: Capability[] = [
	'bans.manage',
	'slots.manage',
	'lists.ban',
	'lists.reserve',
	'config.apply',
	'automation.manage',
	'rcon.raw',
	'rotation.save',
	'players.notes.manage'
];

/** Site owners, organisation owners, and anyone holding a server role with a privileged capability. */
export async function isPrivileged(
	env: Env,
	u: { id: string; role: 'owner' | 'member' }
): Promise<boolean> {
	if (u.role === 'owner') return true;
	const [[org], [grant]] = await Promise.all([
		env.db
			.select({ n: count() })
			.from(orgMembers)
			.where(and(eq(orgMembers.userId, u.id), eq(orgMembers.role, 'owner'))),
		env.db
			.select({ n: count() })
			.from(serverGrants)
			.innerJoin(orgRoles, eq(orgRoles.id, serverGrants.roleId))
			.where(
				and(
					eq(serverGrants.userId, u.id),
					// jsonb containment per capability, bound as text and cast (the idiom access.ts uses:
					// a JS array bound straight to a jsonb or text[] parameter is JSON-encoded by the driver).
					or(
						...PRIVILEGED_CAPS.map(
							(cap) => sql`${orgRoles.capabilities} @> (${JSON.stringify([cap])}::text)::jsonb`
						)
					)
				)
			)
	]);
	return (org?.n ?? 0) > 0 || (grant?.n ?? 0) > 0;
}

export interface EnrolmentPolicy {
	/** the grace clock and the account-page gate apply to this account */
	enforced: boolean;
	/** the banner is shown; false for accounts the rules deliberately leave alone (guests, viewers) */
	nudge: boolean;
}

/**
 * What the `authEnforce` setting means for one account. Advise: banner for all, gate for none.
 * Privileged: gate for owners and dangerous roles, silence for the rest. Everyone: gate for all.
 * Complete accounts need nothing, so the privilege query only runs for those still short.
 */
export async function enrolmentPolicy(
	env: Env,
	u: { id: string; role: 'owner' | 'member'; authComplete: boolean }
): Promise<EnrolmentPolicy> {
	const mode = settings().authEnforce;
	if (mode === AUTH_ENFORCE.advise) return { enforced: false, nudge: true };
	if (mode === AUTH_ENFORCE.everyone) return { enforced: true, nudge: true };
	if (u.authComplete) return { enforced: true, nudge: true };
	const privileged = await isPrivileged(env, u);
	return { enforced: privileged, nudge: privileged };
}
