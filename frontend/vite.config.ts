import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(here, '../..');
const ML_DIR = resolve(here, '../ml');
const DAEMON_PATH = resolve(ML_DIR, 'local/daemon.py');
const DEFAULT_VENV_PYTHON = resolve(ROOT_DIR, '.venv-py312/bin/python');

const DAEMON_PORT = process.env.NUMERAI_LOCAL_DAEMON_PORT ?? '8787';
const DAEMON_PYTHON = process.env.NUMERAI_LOCAL_PYTHON ?? (
	existsSync(DEFAULT_VENV_PYTHON) ? DEFAULT_VENV_PYTHON : 'python3'
);
const DAEMON_ENABLED = process.env.NUMERAI_LOCAL_DAEMON !== '0';

/**
 * Runs the local training daemon (ml/local/daemon.py) alongside `vite dev` so
 * `npm run dev` is the only command needed to launch local (Apple Silicon /
 * MPS) training from the dashboard. The daemon is proxied same-origin at
 * `/local-daemon` (see `server.proxy` below), so the browser needs no CORS and
 * no hard-coded port. Disable with NUMERAI_LOCAL_DAEMON=0; point at a specific
 * interpreter (e.g. a venv with torch) via NUMERAI_LOCAL_PYTHON.
 */
function localTrainingDaemon(): Plugin {
	let child: ChildProcess | null = null;

	const stop = () => {
		if (child && !child.killed) child.kill('SIGTERM');
		child = null;
	};

	return {
		name: 'local-training-daemon',
		apply: 'serve',
		configureServer(server) {
			if (!DAEMON_ENABLED || process.env.VITEST) return;
			if (!existsSync(DAEMON_PATH)) {
				server.config.logger.warn(`[local-daemon] not found at ${DAEMON_PATH}; skipping.`);
				return;
			}

			child = spawn(DAEMON_PYTHON, [DAEMON_PATH, '--port', DAEMON_PORT], {
				cwd: ML_DIR,
				env: { ...process.env, PYTHONUNBUFFERED: '1' }
			});

			const relay = (buf: Buffer) => {
				const text = buf.toString().trimEnd();
				if (text) server.config.logger.info(`\x1b[36m[local-daemon]\x1b[0m ${text}`);
			};
			child.stdout?.on('data', relay);
			child.stderr?.on('data', relay);
			child.on('error', (err) => {
				server.config.logger.warn(
					`[local-daemon] could not start (${err.message}). Local training will be unavailable. ` +
						`Set NUMERAI_LOCAL_PYTHON to a Python with torch installed, or NUMERAI_LOCAL_DAEMON=0 to silence.`
				);
				child = null;
			});
			child.on('exit', (code) => {
				if (code && code !== 0) server.config.logger.warn(`[local-daemon] exited with code ${code}.`);
			});

			server.httpServer?.once('close', stop);
			process.once('exit', stop);
			process.once('SIGINT', stop);
			process.once('SIGTERM', stop);
		},
		closeBundle: stop
	};
}

export default defineConfig({
	plugins: [sveltekit(), localTrainingDaemon()],
	server: {
		fs: {
			allow: ['.']
		},
		proxy: {
			'/local-daemon': {
				target: `http://127.0.0.1:${DAEMON_PORT}`,
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/local-daemon/, '')
			}
		}
	}
});
