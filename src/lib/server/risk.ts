// Advisory connect-time risk for a player, from what Warcon can actually see: the Steam Web API
// (account age, VAC and game bans), the ban lists of the org's other servers, the watchlist, and
// whether the name resembles someone already banned. It is a pointer for an admin, not a verdict:
// nothing here sees aim, position or input, and the RCON API exposes none of those.

export interface RiskProfile {
	public: boolean;
	accountCreatedAt: Date | null;
	vacBans: number;
	gameBans: number;
	daysSinceLastBan: number | null;
	communityBanned: boolean;
	economyBan: string;
}

export interface RiskSignals {
	/** null when Steam has not been asked (no key, or not fetched yet) */
	profile: RiskProfile | null;
	steamEnabled: boolean;
	watched: { reason: string } | null;
	/** bans on other servers in the same org */
	bannedOn: { serverName: string; reason: string }[];
	/** banned players whose last known name looks like this one */
	resembles: { name: string; steamId: string; serverName: string }[];
	now?: Date;
}

export interface RiskReason {
	code: string;
	text: string;
	weight: number;
}
export type RiskLevel = 'low' | 'medium' | 'high';
export interface Risk {
	score: number;
	level: RiskLevel;
	reasons: RiskReason[];
	/** false when Steam signals were unavailable, so a "low" here means "nothing local" */
	steamChecked: boolean;
}

export const RISK_HIGH = 50;
export const RISK_MEDIUM = 20;

const DAY = 86400_000;

/** Whole days since a date, or null. */
export const accountAgeDays = (createdAt: Date | null, now = new Date()): number | null =>
	createdAt ? Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY)) : null;

export function assessRisk(s: RiskSignals): Risk {
	const now = s.now ?? new Date();
	const reasons: RiskReason[] = [];
	const p = s.profile;
	if (p) {
		if (p.vacBans > 0) {
			const recent = p.daysSinceLastBan !== null && p.daysSinceLastBan < 365;
			reasons.push({
				code: 'vac',
				text: `${p.vacBans} VAC ban${p.vacBans === 1 ? '' : 's'}${
					p.daysSinceLastBan !== null ? `, last ${p.daysSinceLastBan} days ago` : ''
				}`,
				weight: recent ? 60 : 50
			});
		}
		if (p.gameBans > 0)
			reasons.push({
				code: 'gameban',
				text: `${p.gameBans} game ban${p.gameBans === 1 ? '' : 's'}`,
				weight: 30
			});
		if (p.communityBanned)
			reasons.push({ code: 'community', text: 'Steam community ban', weight: 10 });
		if (p.economyBan && p.economyBan !== 'none')
			reasons.push({ code: 'economy', text: `Steam economy ban (${p.economyBan})`, weight: 5 });
		const age = accountAgeDays(p.accountCreatedAt, now);
		if (age === null) {
			reasons.push({ code: 'private', text: 'Profile private, account age unknown', weight: 10 });
		} else if (age < 7) {
			reasons.push({
				code: 'age',
				text: `Steam account is ${age} day${age === 1 ? '' : 's'} old`,
				weight: 30
			});
		} else if (age < 30) {
			reasons.push({ code: 'age', text: `Steam account is ${age} days old`, weight: 20 });
		} else if (age < 90) {
			reasons.push({ code: 'age', text: `Steam account is ${age} days old`, weight: 10 });
		}
	}
	for (const b of s.bannedOn)
		reasons.push({
			code: 'banned_elsewhere',
			text: `Banned on ${b.serverName}${b.reason ? `: ${b.reason}` : ''}`,
			weight: 60
		});
	for (const r of s.resembles.slice(0, 3))
		reasons.push({
			code: 'resembles',
			text: `Name resembles banned ${r.name} (${r.steamId}) on ${r.serverName}`,
			weight: 20
		});
	if (s.watched)
		reasons.push({
			code: 'watchlist',
			text: `On the watchlist${s.watched.reason ? `: ${s.watched.reason}` : ''}`,
			weight: 15
		});
	const score = Math.min(
		100,
		reasons.reduce((n, r) => n + r.weight, 0)
	);
	return {
		score,
		level: score >= RISK_HIGH ? 'high' : score >= RISK_MEDIUM ? 'medium' : 'low',
		reasons,
		steamChecked: !!p
	};
}

// ---- name resemblance ---------------------------------------------------------------------------

const LEET: Record<string, string> = {
	'0': 'o',
	'1': 'i',
	'3': 'e',
	'4': 'a',
	'5': 's',
	'7': 't',
	'8': 'b',
	'@': 'a',
	$: 's',
	'!': 'i',
	'|': 'l'
};

/** Lower-case letters only, with the usual leetspeak substitutions undone. */
export function normaliseName(name: string): string {
	return String(name || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c)
		.replace(/[^a-z]/g, '');
}

export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[b.length];
}

/**
 * Do two player names look like the same person? Equal after normalisation, one containing the
 * other (5+ letters), or within one edit (6+ letters) / two edits (10+ letters).
 */
export function namesResemble(a: string, b: string): boolean {
	const x = normaliseName(a);
	const y = normaliseName(b);
	const shorter = Math.min(x.length, y.length);
	if (shorter < 4) return false;
	if (x === y) return true;
	if (shorter >= 5 && (x.includes(y) || y.includes(x))) return true;
	const d = levenshtein(x, y);
	return (shorter >= 6 && d <= 1) || (shorter >= 10 && d <= 2);
}
