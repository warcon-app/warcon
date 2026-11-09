// The Name filter rule's pure part: which characters a name may use and which words it may not
// contain. No database, no game server, no dependency: name-fold.ts is how a word is found
// through leetspeak, look-alike letters and stretched spellings, name-filter-words.ts the built-in
// list with its exceptions.
import { ApiError, int, str } from './http';
import { fold, wordPattern, type WordPattern } from './name-fold';
import { BUILTIN_WORDS } from './name-filter-words';
import { steamIdList } from './steam';

/** The outbox action of an alert-only match: a panel action, nothing is sent to the game. */
export const NAME_FLAG = 'name_flag';

export type CharPolicy = 'off' | 'latin' | 'ascii';
/** Alphabets a Latin policy can let in beside Latin, as Unicode script names. */
export const EXTRA_SCRIPTS = [
	'Cyrillic',
	'Greek',
	'Arabic',
	'Hebrew',
	'Thai',
	'Devanagari',
	'Han',
	'Hiragana',
	'Katakana',
	'Hangul'
] as const;
export type ExtraScript = (typeof EXTRA_SCRIPTS)[number];

/**
 * Acts on a joiner whose name breaks the character policy or holds a blocked word. `latin` keeps
 * accented letters (José, Müller), `ascii` is what a US keyboard types; digits, spaces and ASCII
 * punctuation always pass. `reason` is what the kicked player reads, `{why}` filled in.
 */
export interface NameFilterConfig {
	characters: CharPolicy;
	/** with `latin` only */
	extraScripts: ExtraScript[];
	/** emoji, symbols and punctuation beyond ASCII (【 】 ★ 🐺) */
	allowSymbols: boolean;
	/** a name needs this many letters; 0 is off */
	minLetters: number;
	/** the English list that ships with the matcher */
	builtinWords: boolean;
	blocked: string[];
	/** exceptions: a name part that would match but is fine here */
	allowed: string[];
	/** `alert` writes the audit row (and so the Discord card) and leaves the player on */
	action: 'kick' | 'alert';
	spareReserved: boolean;
	/** SteamIDs the rule never acts on, whatever their name: staff wearing a tag it keeps from
	 *  everyone else (absent on rules saved before it) */
	exempt?: string[];
	reason: string;
}

const MAX_WORDS = 200;
const MAX_EXEMPT = 100;
const WORD = /^[\p{L}\p{N}][\p{L}\p{N} ]{0,38}[\p{L}\p{N}]$/u;

function words(raw: unknown, what: string): string[] {
	const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/);
	const out = new Set<string>();
	for (const item of list) {
		const w = str(item, 60).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
		if (!w) continue;
		if (!WORD.test(w))
			throw new ApiError(
				400,
				`${what} are 2-40 letters, digits or spaces each; '${w.slice(0, 40)}' is not.`
			);
		out.add(w);
	}
	if (out.size > MAX_WORDS) throw new ApiError(400, `${what}: ${MAX_WORDS} at most.`);
	return [...out];
}

export function validateNameFilter(c: Record<string, unknown>): NameFilterConfig {
	const characters: CharPolicy =
		c.characters === 'latin' || c.characters === 'ascii' ? c.characters : 'off';
	const cfg: NameFilterConfig = {
		characters,
		extraScripts:
			characters === 'latin' && Array.isArray(c.extraScripts)
				? EXTRA_SCRIPTS.filter((s) => (c.extraScripts as unknown[]).includes(s))
				: [],
		allowSymbols: !!c.allowSymbols,
		minLetters: int(c.minLetters, 0, 0, 10),
		builtinWords: !!c.builtinWords,
		blocked: words(c.blocked, 'Blocked words'),
		allowed: words(c.allowed, 'Allowed words'),
		action: c.action === 'alert' ? 'alert' : 'kick',
		spareReserved: c.spareReserved === undefined ? true : !!c.spareReserved,
		exempt: steamIdList(c.exempt, MAX_EXEMPT),
		reason: str(c.reason, 200) || 'Your name is not allowed on this server: {why}.'
	};
	if (cfg.characters === 'off' && !cfg.minLetters && !cfg.builtinWords && !cfg.blocked.length)
		throw new ApiError(400, 'Pick a character policy, a word list, or both.');
	return cfg;
}

/** `verdict` is for the audit trail and names what matched; `why` is what the player is told. */
export interface NameVerdict {
	verdict: string;
	why: string;
}

const SYMBOLS = '\\p{P}\\p{S}\\p{Extended_Pictographic}\\u200D\\uFE0F';

function allowedChars(cfg: NameFilterConfig): RegExp | null {
	if (cfg.characters === 'off') return null;
	const letters =
		cfg.characters === 'ascii'
			? ''
			: ['Latin', ...cfg.extraScripts].map((s) => `\\p{Script=${s}}`).join('');
	return new RegExp(`^[\\x20-\\x7E${letters}${cfg.allowSymbols ? SYMBOLS : ''}]*$`, 'u');
}

interface Compiled {
	chars: RegExp | null;
	words: ({ word: string } & WordPattern)[];
	/** taken out of a name before the words are looked for; folded for each reading of a name */
	except: { plain: string[]; leet: string[] };
	exempt: Set<string>;
}

// Compiled once per saved config: the worker holds a rule's config object for as long as its
// enabled-rules cache does, so a join costs a lookup and the match, not a compile.
const compiled = new WeakMap<NameFilterConfig, Compiled>();

function compile(cfg: NameFilterConfig): Compiled {
	const hit = compiled.get(cfg);
	if (hit) return hit;
	const builtin = cfg.builtinWords ? BUILTIN_WORDS : [];
	// Longest first, so "therapist" is taken out before "rapist" could be cut from it.
	const except = [...builtin.flatMap((b) => b.except ?? []), ...cfg.allowed].sort(
		(x, y) => y.length - x.length
	);
	const c: Compiled = {
		chars: allowedChars(cfg),
		words: [...builtin.map((b) => b.word), ...cfg.blocked].map((word) => ({
			word,
			...wordPattern(word)
		})),
		except: { plain: except.map((e) => fold(e)), leet: except.map((e) => fold(e, true)) },
		exempt: new Set(cfg.exempt ?? [])
	};
	compiled.set(cfg, c);
	return c;
}

const POLICY_WHY: Record<Exclude<CharPolicy, 'off'>, string> = {
	latin: 'it uses characters outside the Latin alphabet',
	ascii: 'it uses characters outside plain English letters'
};

/** Why this name breaks the rule, or null when it passes. */
export function nameVerdict(cfg: NameFilterConfig, rawName: string): NameVerdict | null {
	const c = compile(cfg);
	const name = rawName.normalize('NFC');
	if (c.chars && !c.chars.test(name)) {
		const odd = [...name].filter((ch) => !c.chars!.test(ch));
		return {
			verdict: `characters outside the ${cfg.characters === 'ascii' ? 'ASCII' : 'Latin'} policy (${[...new Set(odd)].slice(0, 5).join(' ')})`,
			why: POLICY_WHY[cfg.characters as 'latin' | 'ascii']
		};
	}
	if (cfg.minLetters) {
		const n = (name.match(/\p{L}/gu) ?? []).length;
		if (n < cfg.minLetters)
			return {
				verdict: `${n} letter${n === 1 ? '' : 's'} (minimum ${cfg.minLetters})`,
				why: `it needs at least ${cfg.minLetters} letters`
			};
	}
	const word = blockedWord(c, name);
	return word
		? { verdict: `blocked word '${word}'`, why: 'it contains a word this server does not allow' }
		: null;
}

/**
 * The joiners the rule acts on, each with its verdict. A player on the rule's own list is never
 * one, and a reserved slot is spared when the rule says so.
 */
export function nameFilterTargets<P extends { steamId: string; name: string }>(
	cfg: NameFilterConfig,
	joined: P[],
	reserved: Set<string>
): { player: P; verdict: NameVerdict }[] {
	const { exempt } = compile(cfg);
	const out: { player: P; verdict: NameVerdict }[] = [];
	for (const player of joined) {
		if (exempt.has(player.steamId)) continue;
		if (cfg.spareReserved && reserved.has(player.steamId)) continue;
		const verdict = nameVerdict(cfg, player.name);
		if (verdict) out.push({ player, verdict });
	}
	return out;
}

function blockedWord(c: Compiled, name: string): string | null {
	if (!c.words.length) return null;
	const reading = (leet: boolean) => {
		let text = fold(name, leet);
		for (const ok of leet ? c.except.leet : c.except.plain) text = text.split(ok).join(' ');
		return text;
	};
	const leet = reading(true);
	const plain = c.words.some((w) => !w.leet) ? reading(false) : '';
	return c.words.find((w) => w.pattern.test(w.leet ? leet : plain))?.word ?? null;
}
