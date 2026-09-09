// Cash-in-play helpers shared by the poller (samples) and the dashboard's live chart.
import type { Player, Status } from './types';

export interface FactionCash {
	name: string;
	cash: number;
}

/**
 * Cash held per faction, summed over connected players. Every faction the status names is
 * present (even at 0) so a chart's series never drop out between samples; players without a
 * faction land under ''.
 */
export function cashByFaction(
	status: Pick<Status, 'scores'> | null | undefined,
	players: Player[]
): FactionCash[] {
	const sums = new Map<string, number>((status?.scores ?? []).map((s) => [s.name, 0]));
	for (const p of players) {
		const key = p.faction || '';
		sums.set(key, (sums.get(key) || 0) + (Number(p.cash) || 0));
	}
	return [...sums.entries()].map(([name, cash]) => ({ name, cash }));
}

/** "$1,250" for tables and tooltips. */
export const fmtCash = (n: number | null | undefined): string =>
	n === null || n === undefined ? '—' : '$' + Math.round(n).toLocaleString('en-US');

/** "$12.5k" for axis labels. */
export function fmtCashShort(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1e6) return `$${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
	if (abs >= 1e3) return `$${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
	return `$${Math.round(n)}`;
}
