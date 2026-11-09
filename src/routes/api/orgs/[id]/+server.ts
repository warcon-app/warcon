import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole, requireOwner } from '$lib/server/access';
import { setBanReasons } from '$lib/server/ban-reasons';
import { setSavedMessages } from '$lib/server/saved-messages';
import {
	deleteOrg,
	setBanMessage,
	setMembersReserved,
	setOrgControls,
	updateOrg
} from '$lib/server/orgs';

/**
 * {name} or {discordInviteUrl} or {boardOpens} or {boardHidden} or {membersReserved} or
 * {banMessage} or {banReasons} or {savedMessages} for org owners; {serverLimit, suspended, reason,
 * allowPublicStatus, allowPublicLeaderboards} for the site owner only.
 */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const body = await readJson(event.request);
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	if (
		body.serverLimit !== undefined ||
		body.suspended !== undefined ||
		body.allowPublicStatus !== undefined ||
		body.allowPublicLeaderboards !== undefined
	) {
		requireOwner(event.locals);
		await setOrgControls(env, event.request, user, org, body);
	} else if (body.membersReserved !== undefined) {
		const sync = await setMembersReserved(env, event.request, user, org, !!body.membersReserved);
		return apiJson({ ok: true, sync });
	} else if (body.banMessage !== undefined) {
		const banMessage = await setBanMessage(env, event.request, user, org, body.banMessage);
		return apiJson({ ok: true, banMessage });
	} else if (body.banReasons !== undefined) {
		const banReasons = await setBanReasons(env, event.request, user, org, body.banReasons);
		return apiJson({ ok: true, banReasons });
	} else if (body.savedMessages !== undefined) {
		const savedMessages = await setSavedMessages(env, event.request, user, org, body.savedMessages);
		return apiJson({ ok: true, savedMessages });
	} else {
		await updateOrg(env, event.request, user, org, body);
	}
	return apiJson({ ok: true });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteOrg(env, event.request, user, org);
	return apiJson({ ok: true });
});
