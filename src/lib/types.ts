// Shapes shared by pages, API routes and the action registry.
import type { ServerRole } from '$lib/server/access';

export type { ServerRole };

export interface ServerInfo {
	id: string;
	name: string;
	host: string;
	port: number;
	scheme: 'http' | 'https';
	notes: string;
	role: ServerRole;
	sortOrder: number;
	demo: boolean;
}

export interface CatalogItem {
	id: string;
	display: string;
}
export interface Catalog {
	maps: CatalogItem[];
	lightings: CatalogItem[];
	experiences: CatalogItem[];
}
export interface Features {
	changeTeam: boolean;
	configDocument: boolean;
}

export interface FactionScore {
	name: string;
	colorHex: string;
	score: number;
}
export interface Status {
	serverName: string;
	map: string;
	experiences: string[];
	lighting: string;
	alternator: string;
	scoreTick: number | null;
	scoreTickMin: number | null;
	scoreTickMax: number | null;
	scoreCap: number | null;
	matchSeconds: number | null;
	playerCount: number;
	maxPlayers: number;
	scores: FactionScore[];
	rotationNow: number;
	rotationNext: number;
}
export interface Player {
	name: string;
	steamId: string;
	faction: string | null;
	kills: number;
	deaths: number;
	cash: number;
	ping: number | null;
}
export interface RotationEntry {
	map: string;
	experiences: string[];
	lighting: string;
	zoneAlternator: string;
	denied: boolean;
	status: string;
}
export interface Rotation {
	enabled: boolean;
	mode: string;
	nowIndex: number;
	nextIndex: number;
	entries: RotationEntry[];
}
export interface MapSelection {
	map: string;
	experiences: string[];
	lighting: string;
	zoneAlternator: string;
}
export interface Ban {
	steamId: string;
	bannedAtUtc: string;
	bannedBy: string;
	reason: string;
}
export interface ConfigDoc {
	revision: string;
	writable: boolean;
	text: string;
	sections: unknown[];
	warnings: unknown[];
}
export interface ConfigResult {
	ok: boolean;
	status: number;
	conflict: boolean;
	revision: string;
	errorCode: string;
	errorMessage: string;
	outcomes: { section: string; state: string; detail?: string }[];
	shadowed: { section: string; key: string; declared: string; effective: string }[];
	stripped: unknown[];
	errors: { line?: number; message?: string }[];
	changed: unknown[];
	conflictDeltas: unknown[];
	warnings: unknown[];
	timingsMs: { total?: number } | null;
}
export interface LogEntry {
	timestampUtc: string;
	peer: string;
	sessionId: string;
	event: string;
	detail: string;
}

export interface UserView {
	id: string;
	username: string;
	name: string;
	role: 'owner' | 'member';
	disabled: boolean;
	mustChangePassword: boolean;
	image: string | null;
	createdAt: string | null;
	lastLoginAt: string | null;
	grants: { serverId: string; serverName: string; role: ServerRole }[];
}
