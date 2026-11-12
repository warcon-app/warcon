// The game's welcome popup as it lives in ServerSettings.ini (Season 3): four keys of
// [/Script/WDGame.WDGameStateSession], read when a match starts. The switch, the Close countdown
// and the streamer switch are plain values, fields of the form like any other ($lib/config-fields);
// the text is the ServerWelcomeMessageLines array, one line of the popup each, read and written here
// the way the official console does it.
import {
	decodeText,
	encodeText,
	getArray,
	hasKey,
	parseIni,
	setArrayInText,
	type ParsedIni
} from './config-doc';
import { S_STATE, WELCOME_TEXT } from './config-fields';
import type { ConfigSection } from './types';
import {
	checkWelcome,
	refusedWelcome,
	type WelcomeIssue,
	type WelcomeLimits
} from './welcome-text';

export const WELCOME_LINES_KEY = WELCOME_TEXT.ini;
/** Every key of the popup: the document sets one of these once the popup has been touched. */
export const WELCOME_KEYS = [
	'bServerWelcomeMessageEnabled',
	'ServerWelcomeMessageCloseDelaySeconds',
	'bServerWelcomeMessageSkipForStreamers',
	WELCOME_LINES_KEY
];

/** The popup's lines as the document has them, in order; null when it does not set the key. */
export function welcomeLinesOf(doc: ParsedIni): string[] | null {
	return hasKey(doc, S_STATE, WELCOME_LINES_KEY)
		? getArray(doc, S_STATE, WELCOME_LINES_KEY, decodeText)
		: null;
}
export const welcomeLinesFromText = (text: string): string[] | null =>
	welcomeLinesOf(parseIni(text));

/**
 * Writes the lines back as `!Key=ClearArray` and one `.Key=` line each (so a line said twice, or
 * two blank ones, stay two), touching nothing else in the file.
 */
export function welcomeLinesIntoText(text: string, lines: string[]): string {
	return setArrayInText(text, S_STATE, WELCOME_LINES_KEY, lines, encodeText);
}

export const sameLines = (a: string[], b: string[]): boolean =>
	a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * Whether this server shows any sign of the welcome popup: its status reports the popup's limits
 * (`reported`), its config schema names the text among its keys, or its document already sets one
 * of the popup's keys. A build from before Season 3 does none of these, and drops the keys when a
 * file with them is applied. Only a hint, never a lock: a live server has taken a key its schema
 * did not describe (the daily restart time, October 2026), so the schema alone settles nothing.
 */
export function knowsWelcome(
	sections: ConfigSection[],
	doc: ParsedIni,
	reported: boolean
): boolean {
	if (reported) return true;
	const lines = WELCOME_LINES_KEY.toLowerCase();
	const state = sections.find((s) => s.section.toLowerCase() === S_STATE.toLowerCase());
	if (
		state?.allowedKeys?.some((k) => String(k).toLowerCase() === lines) ||
		state?.keyOverrides?.some((k) => String(k.key).toLowerCase() === lines)
	)
		return true;
	return WELCOME_KEYS.some((key) => hasKey(doc, S_STATE, key));
}

/**
 * What an apply of `text` is asked about before it is sent: the lines of its popup the game
 * refuses, when this edit changed the popup's text. Lines the server already had are the server's
 * own (a file written by hand): the editor flags them, and they do not hold up a change to
 * anything else.
 */
export function welcomeRefusals(
	text: string,
	serverText: string,
	limits: WelcomeLimits
): WelcomeIssue[] {
	const lines = welcomeLinesFromText(text);
	if (!lines || sameLines(lines, welcomeLinesFromText(serverText) ?? [])) return [];
	return refusedWelcome(checkWelcome(lines, limits));
}
