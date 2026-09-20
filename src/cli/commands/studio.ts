/**
 * `codegen studio [projectDir]` — start the Studio server (STUDIO-0, #698).
 *
 * A verb-less top-level command, registered alongside the `init` / `update`
 * shortcuts rather than as a noun: `codegen studio` is the whole surface, so
 * there is no noun summary to generate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'clipanion';

import { STUDIO_DEFAULT_PORT } from '../../studio/shared/api.js';
import { createStudioServer } from '../../studio/server/index.js';
import { printError, printInfo, printSuccess } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';

function readCliVersion(): string {
	try {
		const pkgPath = path.join(import.meta.dirname, '..', '..', '..', 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

export class StudioCommand extends Command {
	static paths = [['studio']];
	static usage = Command.Usage({
		description: 'Start the Studio server (graph, YAML editor, generate + diff)',
		examples: [
			['Serve the project in the current directory', 'codegen studio'],
			['Serve a specific project', 'codegen studio ../demo-app'],
			['Pick a port', 'codegen studio --port 5200'],
			['Proxy to a Vite dev server', 'codegen studio --vite http://127.0.0.1:5179'],
		],
	});

	dir = Option.String({ required: false });
	port = Option.String('--port', String(STUDIO_DEFAULT_PORT));
	vite = Option.String('--vite', { required: false });
	uiDir = Option.String('--ui-dir', { required: false });
	json = Option.Boolean('--json', false);

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);

		const projectDir = path.resolve(process.cwd(), this.dir ?? '.');
		if (!fs.existsSync(projectDir)) {
			printError(`Project directory not found: ${projectDir}`);
			return 1;
		}

		const port = Number.parseInt(this.port, 10);
		if (!Number.isInteger(port) || port < 0 || port > 65535) {
			printError(`Invalid --port: ${this.port}`);
			return 1;
		}

		let server: Awaited<ReturnType<typeof createStudioServer>>;
		try {
			server = await createStudioServer({
				projectDir,
				port,
				viteOrigin: this.vite,
				uiDir: this.uiDir,
				cliVersion: readCliVersion(),
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			printError(
				message.includes('EADDRINUSE')
					? `Port ${port} is already in use — pass --port to pick another.`
					: `Could not start Studio: ${message}`,
			);
			return 1;
		}

		if (isJsonMode()) {
			printJson({ command: 'studio', url: server.url, port: server.port, projectDir });
		} else {
			printSuccess(`Studio listening on ${server.url}`);
			printInfo(`project: ${projectDir}`);
			if (this.vite) printInfo(`proxying the UI to ${this.vite}`);
			printInfo('press Ctrl-C to stop');
		}

		// Hold the process open until a signal arrives — this command IS the
		// server's lifetime.
		await new Promise<void>((resolve) => {
			const stop = () => {
				void server.close().then(resolve, resolve);
			};
			process.once('SIGINT', stop);
			process.once('SIGTERM', stop);
		});
		return 0;
	}
}

export default StudioCommand;
