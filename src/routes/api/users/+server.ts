import { getEnv } from '$lib/server/env';
import { apiJson, readJson, route, str } from '$lib/server/http';
import { requireOwner } from '$lib/server/access';
import { writeAudit } from '$lib/server/audit';
import { createUser, listUsers, validatePassword, validateUsername } from '$lib/server/users';

export const GET = route(async ({ locals }) => {
	const env = getEnv();
	requireOwner(locals);
	return apiJson({ ok: true, users: await listUsers(env) });
});

export const POST = route(async ({ locals, request }) => {
	const env = getEnv();
	const actor = requireOwner(locals);
	const body = await readJson(request);
	const username = validateUsername(body.username);
	const password = validatePassword(body.password);
	const role = body.role === 'owner' ? 'owner' : 'member';
	const id = await createUser(locals.auth!, env, request.headers, {
		username,
		password,
		displayName: str(body.displayName, 80),
		role,
		mustChangePassword: body.mustChangePassword !== false
	});
	await writeAudit(env, request, {
		actor,
		category: 'user',
		action: 'user.create',
		outcome: 'ok',
		target: username,
		detail: { role }
	});
	return apiJson({ ok: true, id }, 201);
});
