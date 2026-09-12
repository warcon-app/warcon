import type { Auth } from '$lib/server/auth';
import type { SessionUser } from '$lib/server/access';
import type { ApiKeyPrincipal } from '$lib/server/apikeys-core';

declare global {
	namespace App {
		interface Locals {
			auth?: Auth;
			/** the signed-in person, or the synthetic user standing in for an API key */
			user: SessionUser | null;
			session: { id: string; token: string; expiresAt: Date } | null;
			/** set when the request carried a valid org API key instead of a session */
			apiKey: ApiKeyPrincipal | null;
		}
		interface Error {
			message: string;
			code?: string;
		}
	}
}

export {};
