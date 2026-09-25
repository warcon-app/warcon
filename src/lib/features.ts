// Which public surfaces a server actually has. Each one needs two switches: the site owner has
// not withdrawn it for the organisation (allowed by default), and an org owner has turned it on
// for the server. This is the one place
// that combines them; public routes, the Discord card links and the server dialog all ask here,
// never a raw column. Client-safe, so the dialog can grey a switch out with the same reason.

export type PublicFeature = 'status' | 'leaderboards'| 'matches';

export const PUBLIC_FEATURES: readonly PublicFeature[] = ['status', 'leaderboards', 'matches'];

export const FEATURE_LABELS: Record<PublicFeature, string> = {
	status: 'Public status page',
	leaderboards: 'Public leaderboards and careers',
	matches: 'Public match list'
};

/** The organisation row's allowances (site owner). */
export interface OrgAllowances {
	allowPublicStatus: boolean;
	allowPublicLeaderboards: boolean;
	allowPublicMatches: boolean;
}
/** The server row's own switches (org owner). */
export interface ServerSwitches {
	publicStatus: boolean;
	publicLeaderboards: boolean;
	publicMatches: boolean;
}

export const NO_ALLOWANCES: OrgAllowances = {
	allowPublicStatus: false,
	allowPublicLeaderboards: false,
	allowPublicMatches: false
};
export const NO_SWITCHES: ServerSwitches = { publicStatus: false, publicLeaderboards: false, publicMatches: false };

export const NOT_ALLOWED = 'Closed for this organisation by the site owner.';

export const allowed = (org: OrgAllowances, feature: PublicFeature): boolean =>
	feature === 'status' ? org.allowPublicStatus : feature === 'leaderboards' ? org.allowPublicLeaderboards : org.allowPublicMatches;

export const wanted = (server: ServerSwitches, feature: PublicFeature): boolean =>
	feature === 'status' ? server.publicStatus : feature === 'leaderboards' ? server.publicLeaderboards : server.publicMatches;

/** On only when the organisation is allowed it and the server has it switched on. */
export const featureOn = (
	org: OrgAllowances,
	server: ServerSwitches,
	feature: PublicFeature
): boolean => allowed(org, feature) && wanted(server, feature);

export interface FeatureSet {
	status: boolean;
	leaderboards: boolean;
	matches: boolean;
}

/** The effective set for one server. */
export const effectiveFeatures = (org: OrgAllowances, server: ServerSwitches): FeatureSet => ({
	status: featureOn(org, server, 'status'),
	leaderboards: featureOn(org, server, 'leaderboards'),
	matches: featureOn(org, server, 'matches')
});

export interface FeatureState {
	on: boolean;
	allowed: boolean;
	wanted: boolean;
	/** why the switch is greyed out, or null when the org owner may use it */
	reason: string | null;
}

/** What the server dialog shows for one switch. */
export function featureState(
	org: OrgAllowances,
	server: ServerSwitches,
	feature: PublicFeature
): FeatureState {
	const a = allowed(org, feature);
	const w = wanted(server, feature);
	return { on: a && w, allowed: a, wanted: w, reason: a ? null : NOT_ALLOWED };
}
