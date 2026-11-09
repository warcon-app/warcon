// Text Postgres will not store, made storable. It refuses NUL in text and in jsonb, and half a
// UTF-16 surrogate pair in jsonb (a text column gets U+FFFD for that from the driver); either
// fails the whole statement. A caller's text and the game's (a player's name cut mid-emoji) can
// hold both, and an audit row written after a game action must not fail on what it records: they
// become U+FFFD wherever the panel writes jsonb or an audit row.
import { sql, type SQL } from 'drizzle-orm';

const fine = (text: string) => text.isWellFormed() && !text.includes('\u0000');

/** The text with NUL and half surrogate pairs as U+FFFD; the same string when it has neither. */
export const storableText = (text: string): string =>
	fine(text) ? text : text.toWellFormed().replaceAll('\u0000', '\uFFFD');

/**
 * A value as JSON.stringify serialises it, whatever its prototype: toJSON applied (a Date becomes
 * its ISO string), and of an object only its own enumerable keys. The walk sees exactly what
 * reaches Postgres, so no object, a crafted `__proto__` included, carries text past it.
 */
const asJson = (value: unknown, key: string): unknown =>
	value !== null &&
	typeof value === 'object' &&
	typeof (value as { toJSON?: unknown }).toJSON === 'function'
		? (value as { toJSON: (key: string) => unknown }).toJSON(key)
		: value;

/** Whether every string the value serialises to, keys included, is storable as it is. */
function storableAsIs(value: unknown): boolean {
	if (typeof value === 'string') return fine(value);
	if (value === null || typeof value !== 'object') return true;
	if (Array.isArray(value)) return value.every((v, i) => storableAsIs(asJson(v, String(i))));
	const record = value as Record<string, unknown>;
	return Object.keys(record).every((key) => fine(key) && storableAsIs(asJson(record[key], key)));
}

function rebuilt(value: unknown): unknown {
	if (typeof value === 'string') return storableText(value);
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((v, i) => rebuilt(asJson(v, String(i))));
	const record = value as Record<string, unknown>;
	// own keys as own keys: a key named __proto__ stays data, never the copy's prototype
	return Object.fromEntries(
		Object.keys(record).map((key) => [storableText(key), rebuilt(asJson(record[key], key))])
	);
}

/** A value for jsonb with every string it serialises to storable; the value itself when it is. */
export const storable = (value: unknown): unknown => {
	const json = asJson(value, '');
	return storableAsIs(json) ? value : rebuilt(json);
};

/** A value as the jsonb parameter of a statement written by hand (jsonb_to_recordset), storable. */
export const jsonParam = (value: unknown): SQL =>
	sql`(${JSON.stringify(storable(value))}::text)::jsonb`;
