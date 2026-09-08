import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Everything is rendered on the server: every page depends on the session and the database.
			adapter: adapter({ out: 'build' })
		})
	],
	// Bun built-ins: resolved by the Bun runtime, never bundled.
	ssr: { external: ['bun'] },
	build: {
		cssMinify: 'lightningcss',
		rollupOptions: { external: ['bun'] }
	}
});
