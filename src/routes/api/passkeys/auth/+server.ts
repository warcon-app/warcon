// Step two of signing in with a passkey. Better Auth checks the assertion against the stored
// credential and sets the session cookie; the login audit row comes from the session hook.
import { getEnv } from '$lib/server/env';
import { apiJson, ApiError, clientIp, publicMessage, readJson, route } from '$lib/server/http';
import { assertRate } from '$lib/server/ratelimit';
import { writeAudit } from '$lib/server/audit';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';

export const POST = route(async ({ locals, request }) => {
	const env = getEnv();
	assertRate(`passkey-auth:${clientIp(request) || 'unknown'}`, 30, 60_000);
	const body = await readJson(request);
	if (!body.response || typeof body.response !== 'object')
		throw new ApiError(400, 'Missing passkey response.');
	try {
		await locals.auth!.api.verifyPasskeyAuthentication({
			body: { response: body.response as AuthenticationResponseJSON },
			headers: request.headers
		});
	} catch (err) {
		await writeAudit(env, request, {
			category: 'auth',
			action: 'login',
			outcome: 'denied',
			target: 'passkey',
			// Better Auth's refusal in its words; anything else (a failed query lists its parameters)
			// goes to the log and the row says only this
			message: publicMessage(err, 'Passkey rejected')
		});
		throw new ApiError(401, 'That passkey was not accepted.', 'passkey_rejected');
	}
	return apiJson({ ok: true });
});
