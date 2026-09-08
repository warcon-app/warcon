import type { Auth } from '$lib/server/auth';
import type { SessionUser } from '$lib/server/access';

declare global {
	namespace App {
		interface Locals {
			auth?: Auth;
			user: SessionUser | null;
			session: { id: string; token: string; expiresAt: Date } | null;
		}
		interface Error {
			message: string;
			code?: string;
		}
	}
}

export {};
