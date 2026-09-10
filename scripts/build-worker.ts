// Bundles the worker (and the migration runner) with Bun, shimming the two SvelteKit virtual
// modules the shared server code imports: $env/dynamic/private becomes process.env and
// $app/environment reports building=false. Output: build/worker.js, build/migrate.js.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BunPlugin } from 'bun';

const root = resolve(import.meta.dir, '..');
const shims: BunPlugin = {
	name: 'sveltekit-shims',
	setup(build) {
		build.onResolve({ filter: /^\$env\/dynamic\/private$/ }, () => ({
			path: 'env-shim',
			namespace: 'shim'
		}));
		build.onResolve({ filter: /^\$app\/environment$/ }, () => ({
			path: 'app-shim',
			namespace: 'shim'
		}));
		build.onLoad({ filter: /.*/, namespace: 'shim' }, (args) => ({
			contents:
				args.path === 'env-shim'
					? 'export const env = process.env;'
					: 'export const building = false; export const dev = false; export const browser = false;',
			loader: 'js'
		}));
		build.onResolve({ filter: /^\$lib\// }, (args) => {
			const base = resolve(root, 'src/lib', args.path.slice('$lib/'.length));
			for (const candidate of [base, `${base}.ts`, `${base}/index.ts`, `${base}.js`])
				if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
			return { path: base };
		});
	}
};

const result = await Bun.build({
	entrypoints: [resolve(root, 'src/worker/worker.ts'), resolve(root, 'src/worker/migrate.ts')],
	outdir: resolve(root, 'build'),
	target: 'bun',
	format: 'esm',
	sourcemap: 'linked',
	naming: '[name].js',
	plugins: [shims],
	external: ['bun', 'bun:*']
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log(`built ${result.outputs.map((o) => o.path.replace(root + '/', '')).join(', ')}`);
