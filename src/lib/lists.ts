// Browser-side helpers for the organisation ban and reserved-slot lists.
import type { Tone } from './components/Badge.svelte';
import type { ListEntryState, ListKind, ListSyncSummary, SlotGroupView } from './types';

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

/** value = days; 0 = permanent; 'custom' = a datetime-local input */
export const EXPIRY_OPTIONS = [
	['0', 'Permanent'],
	['1', '1 day'],
	['3', '3 days'],
	['7', '7 days'],
	['14', '14 days'],
	['30', '30 days'],
	['custom', 'Until a date…']
] as const;

/** The ISO timestamp an expiry choice stands for, or null for permanent. */
export function expiryIso(choice: string, custom: string): string | null {
	if (choice === 'custom') return custom ? new Date(custom).toISOString() : null;
	const days = Number(choice);
	return days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null;
}

const DAY_MS = 86400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A time near now, in the reader's local time and as few words as it takes: "21:30" today,
 * "Sat 20:00" within the week either side, "12 Oct 20:00" further off.
 */
export function whenShort(iso: string, now = new Date()): string {
	const d = new Date(iso);
	const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	if (d.toDateString() === now.toDateString()) return clock;
	if (Math.abs(d.getTime() - now.getTime()) < 6 * DAY_MS)
		return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${clock}`;
	return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock}`;
}

/** An ISO time as a datetime-local input holds it: the reader's local time, to the minute. */
export function localInput(iso: string | null): string {
	if (!iso) return '';
	const d = new Date(iso);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What a reserved-slot group's state reads as, and how it is shown. */
export function groupState(
	g: Pick<SlotGroupView, 'on' | 'onFrom' | 'onUntil' | 'createdAt'>,
	now = new Date()
): { kind: 'on' | 'later' | 'off'; text: string; tone: Tone } {
	if (g.on)
		return {
			kind: 'on',
			text: g.onUntil ? `On until ${whenShort(g.onUntil, now)}` : 'On',
			tone: 'ok'
		};
	if (g.onFrom && g.onUntil && new Date(g.onFrom).getTime() > now.getTime())
		return {
			kind: 'later',
			text: `${whenShort(g.onFrom, now)} – ${whenShort(g.onUntil, now)}`,
			tone: 'info'
		};
	// a group that was never switched on reads as off since it was made: just "Off"
	const never = !g.onUntil || Math.abs(Date.parse(g.onUntil) - Date.parse(g.createdAt)) < 5000;
	return { kind: 'off', text: never ? 'Off' : `Off since ${whenShort(g.onUntil!, now)}`, tone: '' };
}

/**
 * One line for a toast: where a list change landed, and why not where it did not, in the fixed
 * phrase the sync answers (syncPhrase). A run the server stopped answering part-way is `ok` with
 * its phrase in `error`: it did not land either.
 */
export function describeSync(sync: ListSyncSummary, done: string): string {
	const s = sync.servers;
	if (!s.length) return `${done} Servers pick it up on the next poll.`;
	const applied = s.filter((x) => x.ok && !x.failed && !x.error).length;
	const parts = [
		`${done} Applied on ${applied} of ${s.length} server${s.length === 1 ? '' : 's'}.`
	];
	const pending = s.filter((x) => x.pending).map((x) => x.serverName);
	const why = new Map<string, string[]>();
	for (const x of s)
		if (!x.pending && (!x.ok || x.error)) {
			const phrase = x.error || 'The sync failed.';
			why.set(phrase, [...(why.get(phrase) ?? []), x.serverName]);
		}
	const failed = s.filter((x) => x.ok && x.failed).map((x) => x.serverName);
	if (pending.length) parts.push(`Still syncing: ${pending.join(', ')}.`);
	for (const [phrase, names] of why) parts.push(`Not synced on ${names.join(', ')}: ${phrase}`);
	if (failed.length) parts.push(`Refused by: ${failed.join(', ')} (see the list page).`);
	return parts.join(' ');
}
