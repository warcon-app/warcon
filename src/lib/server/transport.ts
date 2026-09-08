// HTTP client for the game server's WDRCON listener: plain fetch to http(s)://host:port.

export interface GameTarget {
	host: string;
	port: number;
	scheme: 'http' | 'https';
}

export interface GameRequestInit {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
	/** Accept self-signed certificates (Bun fetch option; ignored elsewhere). */
	insecureTls?: boolean;
}

export interface GameResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	text: string;
}

export class TransportError extends Error {
	constructor(
		message: string,
		public cause?: unknown
	) {
		super(message);
	}
}

export async function gameRequest(
	target: GameTarget,
	init: GameRequestInit
): Promise<GameResponse> {
	const url = `${target.scheme}://${target.host}:${target.port}${init.path}`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: init.method,
			headers: {
				'user-agent': 'warcon/0.3',
				accept: 'application/json, text/plain, */*',
				...init.headers
			},
			body: init.body,
			signal: AbortSignal.timeout(init.timeoutMs ?? 10000),
			redirect: 'manual',
			...(init.insecureTls ? { tls: { rejectUnauthorized: false } } : {})
		} as RequestInit);
	} catch (err) {
		const cause = (err as { cause?: { code?: string; message?: string } }).cause;
		const detail = cause?.code || cause?.message || (err as Error).message;
		throw new TransportError(`Could not reach ${target.host}:${target.port} (${detail}).`, err);
	}
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k.toLowerCase()] = v;
	});
	return { status: res.status, statusText: res.statusText, headers, text: await res.text() };
}
