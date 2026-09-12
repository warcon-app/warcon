// The pure heart of access.ts: given what the database said about one person on one server,
// what may they do? Kept free of db and SvelteKit imports so it can be unit tested with plain
// objects, and so API keys (which carry their own capability set) resolve through the same shape.
import { CAPABILITIES, knownCapabilities, type Capability } from '../capabilities';

export interface ServerAccess {
	caps: Set<Capability>;
	/** the granted role's name; 'owner' when access comes from running the org */
	roleName: string;
	roleId: string | null;
	/** true when access comes from owning the org (or the panel) rather than a grant */
	manager: boolean;
}

export interface GrantLike {
	roleId: string;
	roleName: string;
	/** the org_roles.capabilities jsonb as read back (trusted, but tolerant of renames) */
	capabilities: unknown;
}

export const managerAccess = (): ServerAccess => ({
	caps: new Set<Capability>(CAPABILITIES),
	roleName: 'owner',
	roleId: null,
	manager: true
});

export const accessFromCaps = (
	caps: Iterable<Capability>,
	roleName: string,
	roleId: string | null = null
): ServerAccess => ({
	caps: new Set(caps),
	roleName,
	roleId,
	manager: false
});

/**
 * A suspended org closes every door except the site owner's (callers handle that case before
 * asking). Managers hold everything; otherwise access is exactly the granted role's list.
 */
export function resolveAccess(input: {
	manager: boolean;
	suspended?: boolean;
	grant?: GrantLike | null;
}): ServerAccess | null {
	if (input.suspended) return null;
	if (input.manager) return managerAccess();
	const g = input.grant;
	if (!g) return null;
	return accessFromCaps(knownCapabilities(g.capabilities), g.roleName, g.roleId);
}
