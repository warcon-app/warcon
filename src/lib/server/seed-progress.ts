export interface SeedProgressEntry {
	/** all-time seed seconds seen when this balance was last updated */
	observed: number;
	/** unspent seed seconds toward the next reward */
	balance: number;
	seenAt: number;
}

export interface SeedProgressState {
	players: Record<string, SeedProgressEntry>;
}

/** Reads persisted seeding reward progress defensively; old and malformed trigger state is empty. */
export function seedProgress(raw: unknown): SeedProgressState {
	const input =
		raw && typeof raw === 'object' && (raw as { players?: unknown }).players
			? ((raw as { players: unknown }).players as Record<string, unknown>)
			: {};
	const players: Record<string, SeedProgressEntry> = {};
	for (const [steamId, value] of Object.entries(input)) {
		if (!value || typeof value !== 'object') continue;
		const v = value as Record<string, unknown>;
		if (
			typeof v.observed === 'number' &&
			Number.isFinite(v.observed) &&
			typeof v.balance === 'number' &&
			Number.isFinite(v.balance) &&
			typeof v.seenAt === 'number' &&
			Number.isFinite(v.seenAt)
		)
			players[steamId] = {
				observed: Math.max(0, Math.floor(v.observed)),
				balance: Math.max(0, Math.floor(v.balance)),
				seenAt: v.seenAt
			};
	}
	return { players };
}

export const seedBalanceSeconds = (raw: unknown, steamId: string): number =>
	seedProgress(raw).players[steamId]?.balance ?? 0;
