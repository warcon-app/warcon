// Which game-server addresses Warcon will talk to. Warcon fetches on behalf of whoever added a
// server, so an entry pointing at 127.0.0.1, the Docker network or the cloud metadata service
// would turn the panel into a proxy into its own host. Only the site owner may register private
// targets (a same-box or LAN listener); link-local is never a game server and stays blocked for
// everyone. The check runs when the target is saved and again before every outbound request, so a
// hostname that later re-points at an internal address is caught too.
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { ApiError } from './http';

export type AddressKind = 'public' | 'private' | 'linklocal';

/** Address text with optional IPv6 brackets stripped. */
const bare = (host: string) =>
	host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

function v4Octets(ip: string): number[] | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	return out.every((n) => n >= 0 && n <= 255) ? out : null;
}

function classifyV4(o: number[]): AddressKind {
	const [a, b] = o;
	if (a === 169 && b === 254) return 'linklocal';
	if (a === 0 || a === 10 || a === 127) return 'private';
	if (a === 100 && b >= 64 && b <= 127) return 'private'; // carrier-grade NAT
	if (a === 172 && b >= 16 && b <= 31) return 'private';
	if (a === 192 && b === 168) return 'private';
	if (a === 192 && b === 0 && (o[2] === 0 || o[2] === 2)) return 'private'; // IETF protocol, TEST-NET-1
	if (a === 198 && (b === 18 || b === 19)) return 'private'; // benchmarking
	if (a === 198 && b === 51 && o[2] === 100) return 'private'; // TEST-NET-2
	if (a === 203 && b === 0 && o[2] === 113) return 'private'; // TEST-NET-3
	if (a >= 224) return 'private'; // multicast, reserved, broadcast
	return 'public';
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function v6Groups(ip: string): number[] | null {
	let text = ip.split('%')[0]; // drop a zone id
	// Embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
	const tail = text.match(/:(\d+\.\d+\.\d+\.\d+)$/);
	if (tail) {
		const o = v4Octets(tail[1]);
		if (!o) return null;
		text =
			text.slice(0, -tail[1].length) +
			((o[0] << 8) | o[1]).toString(16) +
			':' +
			((o[2] << 8) | o[3]).toString(16);
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const parse = (s: string) =>
		s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
	const head = parse(halves[0]);
	const rest = halves.length === 2 ? parse(halves[1]) : [];
	if ([...head, ...rest].some(Number.isNaN)) return null;
	const missing = 8 - head.length - rest.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	return [...head, ...new Array(missing).fill(0), ...rest];
}

function classifyV6(g: number[]): AddressKind {
	const top = g[0];
	if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
		// ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (deprecated compatible), :: and ::1
		if (g[6] === 0 && g[7] <= 1) return 'private';
		return classifyV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
	}
	if (top === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
		return classifyV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // NAT64 well-known prefix
	if ((top & 0xffc0) === 0xfe80) return 'linklocal';
	if ((top & 0xfe00) === 0xfc00) return 'private'; // unique local fc00::/7
	if ((top & 0xff00) === 0xff00) return 'private'; // multicast
	if (top === 0x2001 && g[1] === 0x0db8) return 'private'; // documentation
	if (top === 0 && g.slice(1, 8).every((x) => x === 0)) return 'private';
	return 'public';
}

/** Classifies one IP address; null when the text is not an address at all. */
export function classifyAddress(ip: string): AddressKind | null {
	const text = bare(ip.trim());
	const o = v4Octets(text);
	if (o) return classifyV4(o);
	const g = v6Groups(text);
	return g ? classifyV6(g) : null;
}

/**
 * Canonical host text for URLs: lowercase, IPv6 literals bracketed. Throws on anything that is
 * neither a hostname nor an IP literal.
 */
export function normaliseHost(raw: string): string {
	const host = raw.trim().toLowerCase();
	if (!host) throw new ApiError(400, 'host is required.');
	const inner = bare(host);
	if (isIP(inner) === 6) return `[${inner}]`;
	if (host.includes(':') || host.includes('[') || host.includes(']'))
		throw new ApiError(400, 'host must be a hostname, an IPv4 address or an IPv6 address.');
	if (
		host.length > 253 ||
		!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
	)
		throw new ApiError(400, 'host must be a hostname or IP address.');
	return host;
}

export interface Resolved {
	address: string;
	kind: AddressKind;
}

/** Every address the host currently resolves to (or the literal itself). */
export async function resolveHost(host: string): Promise<Resolved[]> {
	const literal = bare(host);
	const literalKind = isIP(literal) ? classifyAddress(literal) : null;
	if (literalKind) return [{ address: literal, kind: literalKind }];
	let found: { address: string }[];
	try {
		found = await lookup(literal, { all: true, verbatim: true });
	} catch (err) {
		const code = (err as { code?: string }).code || 'lookup failed';
		throw new ApiError(400, `${host} does not resolve (${code}).`, 'unresolvable');
	}
	const out: Resolved[] = [];
	for (const { address } of found) {
		const kind = classifyAddress(address);
		if (kind) out.push({ address, kind });
	}
	if (!out.length) throw new ApiError(400, `${host} does not resolve.`, 'unresolvable');
	return out;
}

/**
 * Throws unless every address behind `host` is one this caller may reach. Site owners may use
 * private addresses; link-local is refused for everyone. Returns the resolved addresses.
 */
export async function assertReachableTarget(
	host: string,
	allowPrivate: boolean
): Promise<Resolved[]> {
	const resolved = await resolveHost(host);
	const literal = isIP(bare(host)) !== 0;
	const where = (r: Resolved) => (literal ? `${host} is` : `${host} resolves to ${r.address},`);
	const linkLocal = resolved.find((r) => r.kind === 'linklocal');
	if (linkLocal)
		throw new ApiError(
			403,
			`${where(linkLocal)} a link-local address; that is never a game server.`,
			'blocked_host'
		);
	const priv = resolved.find((r) => r.kind === 'private');
	if (priv && !allowPrivate)
		throw new ApiError(
			403,
			`${where(priv)} a private address. Only publicly reachable game servers can be added here. If the game server shares a machine or network with Warcon, ask the site owner to add it.`,
			'blocked_host'
		);
	return resolved;
}

/**
 * The request path for the game server, normalised the way a URL parser will read it, so encoded
 * dot segments cannot climb out of /v1/. Returns pathname plus query.
 */
export function gamePath(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw, 'http://game.invalid');
	} catch {
		throw new ApiError(400, 'path is not a valid request path.');
	}
	if (url.host !== 'game.invalid' || !raw.startsWith('/'))
		throw new ApiError(400, 'path must start with /v1/.');
	const path = url.pathname;
	if (url.hash || !path.startsWith('/v1/') || path.includes('..') || /%2e/i.test(path))
		throw new ApiError(400, 'path must start with /v1/.');
	return path + url.search;
}
