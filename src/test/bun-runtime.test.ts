// The Bun the image runs is a release named in the Dockerfile, never a floating tag, and none
// older than the Brotli decoder fix (CVE-2026-111497, Bun 1.4.4): the worker's fetch() asks every
// game server for Brotli and decodes the answer, and anyone who can add a server picks the bytes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const FIXED = '1.4.4';

describe('the Bun the panel runs on', () => {
	test('every image stage is an exact Bun release with the Brotli fix', () => {
		const stages = [...read('Dockerfile').matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
		expect(stages.length).toBeGreaterThan(0);
		for (const image of stages) {
			// oven/bun:1.4.4 or oven/bun:1.4.4-slim; oven/bun:1, :1.4 or :latest float.
			const version = /^oven\/bun:(\d+\.\d+\.\d+)(?:-[a-z]+)?$/.exec(image)?.[1];
			expect(version, `${image} is not an exact Bun release`).toBeString();
			expect(
				Bun.semver.order(version!, FIXED),
				`${image} predates ${FIXED}`
			).toBeGreaterThanOrEqual(0);
		}
	});

	test('package.json asks for that Bun or newer', () => {
		const { engines } = JSON.parse(read('package.json')) as { engines: { bun: string } };
		expect(Bun.semver.satisfies('1.4.3', engines.bun)).toBe(false);
		expect(Bun.semver.satisfies(FIXED, engines.bun)).toBe(true);
	});
});
