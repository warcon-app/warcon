import { MAX_CHAT } from '$lib/chat';

/** One RCON broadcast. Unknown next-map data is shown as — rather than guessed. */
export const DEFAULT_LEADERS_MESSAGE =
	'LEADERS\n{kills_name} — {kills} kills\n{cash_name} — ${cash} cash\n{streak_name} — {streak_count} kill streak\n\nNEXT: {next_map}\nWeather: {next_weather}';
export const LEADERS_MESSAGE_VARS = [
	'kills_name', 'kills', 'cash_name', 'cash', 'streak', 'streak_name', 'streak_count', 'next_map', 'next_weather'
] as const;
export interface LeadersMessageData {
	killsName: string; kills: number; cashName: string; cash: number;
	streakName?: string; streakCount?: number; nextMap?: string; nextWeather?: string;
}
export function renderLeadersMessage(template: string | undefined, data: LeadersMessageData): string {
	const safe = (name: string) => name.replace(/[\r\n\t]+/g, ' ').slice(0, 80);
	const streakName = data.streakCount && data.streakName ? safe(data.streakName) : '';
	const count = streakName ? data.streakCount! : 0;
	const source = template || DEFAULT_LEADERS_MESSAGE;
	const streakSeparator = source.includes('\n') ? '\n' : ' | ';
	const values: Record<string, string> = {
		kills_name: safe(data.killsName), kills: String(data.kills),
		cash_name: safe(data.cashName), cash: data.cash.toLocaleString('en-US'),
		streak: count ? `${streakSeparator}${streakName} — ${count} kill streak` : '',
		streak_name: streakName || '—', streak_count: count ? String(count) : '—',
		next_map: data.nextMap ? safe(data.nextMap) : '—',
		next_weather: data.nextWeather ? safe(data.nextWeather) : '—'
	};
	const result = source
		.replace(/\{([a-z_]+)\}/gi, (match, key: string) => values[key.toLowerCase()] ?? match)
		.slice(0, MAX_CHAT);
	return (/[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result).trim();
}
