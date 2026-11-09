// What each kind of check must answer to each member of the cast (world.ts). Written out from
// the rules in access.ts's header, not computed from its code: the matrix test compares the two.
//
//   401  nobody is signed in
//   404  signed in, but this org or server does not exist as far as they can tell
//   403  they can see it, and may not do this
//   ok   the check let them through (whatever the handler then made of an empty request)
import { BUILTIN_CAPABILITIES, CAPABILITIES, type Capability } from '$lib/capabilities';
import type { ListKind } from '$lib/types';
import type { PrincipalName } from './world';

export type Expect = 401 | 403 | 404 | 'ok';

export type Policy =
	| 'open' // no check at all
	| 'user' // any signed-in person or key
	| 'anyServer' // someone who can open at least one server, anywhere
	| 'person' // a signed-in person; keys are refused
	| 'site' // the site owner
	| 'orgOwner' // an owner of the org (or the site owner); never a key
	| 'lists' // an org owner, or either org list's capability on any server of the org
	| `lists:${ListKind}` // an org owner, or that list's capability on any server of the org
	| 'listsOwner' // an org owner, among those who can open the lists
	| 'listsHere' // either org list's capability on this server
	| 'manager' // an owner of the server's org (or the site owner); never a key
	| `cap:${Capability}` // the capability on this server
	| `anyCap:${Capability}`; // the capability on any server of the org

const ALL: readonly Capability[] = CAPABILITIES;

/** What each of the cast holds on the server under test; absent = cannot see it. */
const CAPS: Partial<Record<PrincipalName, readonly Capability[]>> = {
	viewer: BUILTIN_CAPABILITIES.viewer,
	operator: BUILTIN_CAPABILITIES.operator,
	admin: BUILTIN_CAPABILITIES.admin,
	owner: ALL,
	site: ALL,
	keyView: ['server.view'],
	keyAll: ALL,
	orgBans: ['server.view', 'lists.ban'],
	orgSlots: ['server.view', 'lists.reserve'],
	keyBans: ['server.view', 'lists.ban']
};

/**
 * What each holds on whichever server of the org gives them the most: the server under test, or
 * for `elsewhere` and `keyElsewhere` the other one (a key held to some servers carries no org list
 * capability on them).
 */
const ANY_CAPS: Partial<Record<PrincipalName, readonly Capability[]>> = {
	...CAPS,
	elsewhere: ALL,
	keyElsewhere: ALL.filter((c) => c !== 'lists.ban' && c !== 'lists.reserve')
};

const KEYS: PrincipalName[] = ['keyView', 'keyAll', 'keyElsewhere', 'keyBans'];
const RUNS_ORG: PrincipalName[] = ['owner', 'site'];
const IN_ORG: PrincipalName[] = [
	'member',
	'viewer',
	'operator',
	'admin',
	'elsewhere',
	'orgBans',
	'orgSlots'
];
/**
 * Who edits each org list besides its owners: a role holding the list's capability somewhere in
 * the org (the admin role, on this server or the other one, or a role with that one list), and a
 * key over the whole org that carries it. The org lists reach every server, so a key held to
 * some servers (`keyElsewhere`) cannot open them whatever it carries.
 */
const LIST_EDITORS: Record<ListKind, PrincipalName[]> = {
	ban: ['admin', 'elsewhere', 'orgBans', 'keyAll', 'keyBans'],
	reserve: ['admin', 'elsewhere', 'orgSlots', 'keyAll']
};
const ANY_LIST: PrincipalName[] = [...new Set([...LIST_EDITORS.ban, ...LIST_EDITORS.reserve])];

export function expected(policy: Policy, who: PrincipalName): Expect {
	if (policy === 'open') return 'ok';
	if (who === 'anon') return 401;
	switch (policy) {
		case 'user':
			return 'ok';
		case 'anyServer':
			// `outsider` runs a server of their own; `member` and `stranger` have none to look at.
			return who === 'stranger' || who === 'member' ? 403 : 'ok';
		case 'person':
			return KEYS.includes(who) ? 403 : 'ok';
		case 'site':
			return who === 'site' ? 'ok' : 403;
		case 'orgOwner':
			if (RUNS_ORG.includes(who)) return 'ok';
			return KEYS.includes(who) || IN_ORG.includes(who) ? 403 : 404;
		case 'lists':
			return RUNS_ORG.includes(who) || ANY_LIST.includes(who) ? 'ok' : 404;
		case 'lists:ban':
		case 'lists:reserve': {
			const kind = policy.slice('lists:'.length) as ListKind;
			if (RUNS_ORG.includes(who) || LIST_EDITORS[kind].includes(who)) return 'ok';
			// the other list's editors can see the org, and may not do this
			return ANY_LIST.includes(who) ? 403 : 404;
		}
		case 'listsOwner':
			if (RUNS_ORG.includes(who)) return 'ok';
			return ANY_LIST.includes(who) ? 403 : 404;
		case 'listsHere': {
			const held = CAPS[who];
			if (!held) return 404;
			return held.includes('lists.ban') || held.includes('lists.reserve') ? 'ok' : 403;
		}
		case 'manager':
			if (RUNS_ORG.includes(who)) return 'ok';
			if (KEYS.includes(who)) return 403;
			return CAPS[who] ? 403 : 404;
		default: {
			const any = policy.startsWith('anyCap:');
			const cap = policy.slice(policy.indexOf(':') + 1) as Capability;
			const held = (any ? ANY_CAPS : CAPS)[who];
			if (!held) return 404;
			return held.includes(cap) ? 'ok' : 403;
		}
	}
}

/** The two refusals that mean "you cannot see this", as opposed to a missing role, note or rule. */
const HIDDEN = new Set([
	'Organisation not found.',
	'Server not found.',
	'Server not found, or you have no access to it.'
]);

/** Reduces a handler's answer to the four outcomes above; a 5xx is never an acceptable answer. */
export function outcomeOf(o: { status: number; message: string }): Expect | `error ${number}` {
	if (o.status >= 500) return `error ${o.status}`;
	if (o.status === 401 || o.status === 403) return o.status;
	if (o.status === 404 && HIDDEN.has(o.message)) return 404;
	return 'ok';
}
