// Browser-side helpers for the organisation ban and reserved-slot lists.
import type { Tone } from './components/Badge.svelte';
import type { ListEntryState, ListKind, ListSyncSummary } from './types';

export const KIND_TITLE: Record<ListKind, string> = { ban: 'Ban list', reserve: 'Reserved slots' };

export const STATE_TONE: Record<ListEntryState, Tone> = {
	applied: 'ok',
	failed: 'err',
	pending: 'warn',
	local: ''
};

export const STATE_TEXT: Record<ListEntryState, string> = {
	applied: 'applied by the panel',
	failed: 'could not be applied',
	pending: 'waiting for the next sync',
	local: 'already on the server, added outside the panel'
};

export const REASON_PRESETS = [
	'Cheating',
	'Team killing',
	'Toxic behaviour',
	'Racism / hate speech',
	'Ban evasion',
	'Griefing'
];

/** value = days; 0 = permanent; 'custom' = a datetime-local input */
export const EXPIRY_OPTIONS = [
	['0', 'Permanent'],
	['1', '1 day'],
	['7', '7 days'],
	['30', '30 days'],
	['custom', 'Until a date…']
] as const;

/** The ISO timestamp an expiry choice stands for, or null for permanent. */
export function expiryIso(choice: string, custom: string): string | null {
	if (choice === 'custom') return custom ? new Date(custom).toISOString() : null;
	const days = Number(choice);
	return days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null;
}

/** One line for a toast: where a list change landed. */
export function describeSync(sync: ListSyncSummary, done: string): string {
	const s = sync.servers;
	if (!s.length) return `${done} Servers pick it up on the next poll.`;
	const applied = s.filter((x) => x.ok && !x.failed).length;
	const parts = [
		`${done} Applied on ${applied} of ${s.length} server${s.length === 1 ? '' : 's'}.`
	];
	const pending = s.filter((x) => x.pending).map((x) => x.serverName);
	const down = s.filter((x) => !x.ok && !x.pending).map((x) => x.serverName);
	const failed = s.filter((x) => x.ok && x.failed).map((x) => x.serverName);
	if (pending.length) parts.push(`Still syncing: ${pending.join(', ')}.`);
	if (down.length) parts.push(`Unreachable, will retry: ${down.join(', ')}.`);
	if (failed.length) parts.push(`Refused by: ${failed.join(', ')} (see the list page).`);
	return parts.join(' ');
}
