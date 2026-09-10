// The organisation scope: which org's servers the dashboard, switcher and Servers page show.
// A browser-level choice (cookie) wins; otherwise the account's default organisation; otherwise
// everything the user can see. It never widens access: it only filters what is already visible.
import type { Cookies } from '@sveltejs/kit';
import type { OrgSummary, SessionUser } from './access';

export const SCOPE_COOKIE = 'warcon_scope';
/** cookie value meaning "every organisation", overriding a default org */
const ALL = 'all';
const YEAR_S = 365 * 24 * 3600;

export interface Scope {
	id: string;
	name: string;
	/** true when the scope comes from the cookie rather than the account default */
	session: boolean;
}

/** The org in effect for this request, or null for every organisation. */
export function resolveScope(
	cookies: Cookies,
	user: SessionUser,
	orgs: OrgSummary[]
): Scope | null {
	const raw = cookies.get(SCOPE_COOKIE);
	const wanted = raw === undefined ? user.defaultOrgId : raw === ALL ? null : raw;
	if (!wanted) return null;
	const org = orgs.find((o) => o.id === wanted);
	// A stale cookie (org deleted, membership gone) falls back to everything rather than to nothing.
	return org ? { id: org.id, name: org.name, session: raw !== undefined } : null;
}

/** Remember a browser-level scope; null pins "all organisations" over the account default. */
export function setScopeCookie(cookies: Cookies, orgId: string | null): void {
	cookies.set(SCOPE_COOKIE, orgId ?? ALL, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: YEAR_S
	});
}

/** Forget the browser-level scope so the account default applies again. */
export function clearScopeCookie(cookies: Cookies): void {
	cookies.delete(SCOPE_COOKIE, { path: '/' });
}
