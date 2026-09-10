// Entry point of the worker process (WARCON_ROLE=worker): bun ./build/worker.js
import { initEnv } from '$lib/server/env';
import { loadSettings } from '$lib/server/settings';
import { startWorker, stopWorker } from './runtime';

const env = await initEnv({ role: 'worker' });
await loadSettings(env);
const server = startWorker(env, `worker@${process.env.HOSTNAME || 'local'}`);

let stopping = false;
const shutdown = async (signal: string) => {
	if (stopping) return;
	stopping = true;
	console.log(`[warcon] ${signal}: worker stopping`);
	await stopWorker();
	server.stop(true);
	await env.sql.end().catch(() => {});
	process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
