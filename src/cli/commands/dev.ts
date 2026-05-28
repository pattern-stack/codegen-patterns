/**
 * Dev noun — codegen dev / dev up / dev down / dev status / dev logs / dev restart
 *
 * Manages the development environment for a generated NestJS + Drizzle project:
 * Docker services (Postgres + Redis), schema migrations, and the NestJS app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';

import { loadContext, type Context } from '../shared/context.js';
import { findYamlFiles } from '../../utils/find-yaml-files.js';
import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import { renderPane, type PaneOutput } from '../ui/pane.js';
import { renderHints, type Hint } from '../ui/hints.js';
import type { NounModule } from '../noun-module.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_APP_PORT = 3000;
const DEFAULT_PG_PORT = 5433;
const DEFAULT_REDIS_PORT = 6380;
const COMPOSE_FILE = 'docker-compose.dev.yml';
const PID_FILE = '.dev-app.pid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCmd(cmd: string, cwd: string, opts?: { silent?: boolean }): {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
} {
	const parts = cmd.split(' ');
	const r = spawnSync(parts[0], parts.slice(1), {
		cwd,
		encoding: 'utf-8',
		timeout: 30_000,
	});
	return {
		ok: r.status === 0,
		stdout: r.stdout ?? '',
		stderr: r.stderr ?? '',
		code: r.status ?? 1,
	};
}

function getAppPort(ctx: Context): number {
	const env = (ctx.config as Record<string, unknown> | null)?.dev as
		| Record<string, unknown>
		| undefined;
	return Number(env?.port ?? process.env.PORT ?? DEFAULT_APP_PORT);
}

function getPgPort(_ctx: Context): number {
	return Number(process.env.DEV_PG_PORT ?? DEFAULT_PG_PORT);
}

function getRedisPort(_ctx: Context): number {
	return Number(process.env.DEV_REDIS_PORT ?? DEFAULT_REDIS_PORT);
}

function composeFilePath(cwd: string): string {
	// Check for dev compose first, then fall back to root compose
	const devPath = path.join(cwd, COMPOSE_FILE);
	if (fs.existsSync(devPath)) return devPath;
	const rootPath = path.join(cwd, 'docker-compose.yml');
	if (fs.existsSync(rootPath)) return rootPath;
	return devPath; // will be created
}

function pidFilePath(cwd: string): string {
	return path.join(cwd, PID_FILE);
}

function readAppPid(cwd: string): number | null {
	const p = pidFilePath(cwd);
	if (!fs.existsSync(p)) return null;
	const pid = parseInt(fs.readFileSync(p, 'utf-8').trim(), 10);
	if (isNaN(pid)) return null;
	// Check if process is alive
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		// Process dead — clean up stale PID file
		fs.rmSync(p, { force: true });
		return null;
	}
}

function writeAppPid(cwd: string, pid: number): void {
	fs.writeFileSync(pidFilePath(cwd), String(pid));
}

function clearAppPid(cwd: string): void {
	fs.rmSync(pidFilePath(cwd), { force: true });
}

interface ServiceStatus {
	name: string;
	host: string;
	port: number;
	healthy: boolean;
	pid?: number;
}

function checkPostgres(cwd: string, port: number): ServiceStatus {
	const r = runCmd(`docker exec codegen-dev-postgres pg_isready -U postgres`, cwd, {
		silent: true,
	});
	return {
		name: 'postgres',
		host: 'localhost',
		port,
		healthy: r.ok,
	};
}

function checkRedis(cwd: string, port: number): ServiceStatus {
	const r = runCmd(`docker exec codegen-dev-redis redis-cli ping`, cwd, { silent: true });
	return {
		name: 'redis',
		host: 'localhost',
		port,
		healthy: r.ok && r.stdout.trim() === 'PONG',
	};
}

function checkApp(cwd: string, port: number): ServiceStatus {
	const pid = readAppPid(cwd);
	if (!pid) return { name: 'app', host: 'localhost', port, healthy: false };

	// Quick HTTP check
	const r = runCmd(
		`curl -s -o /dev/null -w %{http_code} http://localhost:${port}/`,
		cwd,
		{ silent: true },
	);
	const code = parseInt(r.stdout.trim(), 10);
	return {
		name: 'app',
		host: 'localhost',
		port,
		healthy: code >= 200 && code < 500,
		pid,
	};
}

function listEntityNames(ctx: Context): string[] {
	if (!ctx.entitiesDir || !fs.existsSync(ctx.entitiesDir)) return [];
	return findYamlFiles(ctx.entitiesDir).map((f) =>
		path.basename(f).replace(/\.ya?ml$/, ''),
	);
}

function formatServiceLine(svc: ServiceStatus): string {
	const icon = svc.healthy ? theme.success(icons.check) : theme.error(icons.error);
	const status = svc.healthy ? theme.success('healthy') : theme.error('stopped');
	const pidStr = svc.pid ? `    PID ${svc.pid}` : '';
	return `${icon} ${svc.name.padEnd(12)}  ${theme.muted(`${svc.host}:${svc.port}`)}    ${status}${pidStr}`;
}

function ensureComposeFile(cwd: string, pgPort: number, redisPort: number): string {
	const composePath = path.join(cwd, COMPOSE_FILE);
	if (fs.existsSync(composePath)) return composePath;

	const content = `# Auto-generated by codegen dev
# Ports offset from defaults to avoid conflicts with other local services.
services:
  postgres:
    image: postgres:16-alpine
    container_name: codegen-dev-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: codegen_dev
    ports:
      - "${pgPort}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d codegen_dev"]
      interval: 2s
      timeout: 2s
      retries: 20
    volumes:
      - codegen-dev-pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    container_name: codegen-dev-redis
    ports:
      - "${redisPort}:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 20

volumes:
  codegen-dev-pgdata:
`;
	fs.writeFileSync(composePath, content);
	return composePath;
}

// ---------------------------------------------------------------------------
// DevUpCommand
// ---------------------------------------------------------------------------

export class DevUpCommand extends Command {
	static paths = [['dev', 'up']];
	static usage = Command.Usage({
		description:
			'Start Docker services (Postgres + Redis), run migrations, start the NestJS app',
		examples: [
			['Start everything', 'codegen dev up'],
			['Skip app start (services only)', 'codegen dev up --no-app'],
		],
	});

	noApp = Option.Boolean('--no-app', false);
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		const pgPort = getPgPort(ctx);
		const redisPort = getRedisPort(ctx);
		const appPort = getAppPort(ctx);

		// 1. Ensure docker-compose file exists
		const composePath = ensureComposeFile(ctx.cwd, pgPort, redisPort);

		// 2. Start Docker services
		if (!isJsonMode()) printInfo('starting Docker services...');
		const composeUp = runCmd(
			`docker compose -f ${composePath} up -d --wait`,
			ctx.cwd,
		);
		if (!composeUp.ok) {
			printError(`docker compose failed: ${composeUp.stderr.slice(0, 300)}`);
			return 1;
		}
		if (!isJsonMode()) printSuccess('Docker services running');

		// 3. Wait for health checks
		let pgReady = false;
		let redisReady = false;
		for (let i = 0; i < 15; i++) {
			if (!pgReady) pgReady = checkPostgres(ctx.cwd, pgPort).healthy;
			if (!redisReady) redisReady = checkRedis(ctx.cwd, redisPort).healthy;
			if (pgReady && redisReady) break;
			spawnSync('sleep', ['1']);
		}

		if (!pgReady) printWarning('postgres did not become healthy in time');
		if (!redisReady) printWarning('redis did not become healthy in time');

		// 4. Run schema push/migration if drizzle config exists
		const drizzleConfig = ['drizzle.config.ts', 'drizzle.config.js'].find((f) =>
			fs.existsSync(path.join(ctx.cwd, f)),
		);
		if (drizzleConfig) {
			if (!isJsonMode()) printInfo('pushing database schema...');
			const dbUrl = `postgres://postgres:postgres@localhost:${pgPort}/codegen_dev`;
			const push = runCmd(`bunx drizzle-kit push --config ${drizzleConfig}`, ctx.cwd);
			if (!push.ok) {
				printWarning(`schema push may have failed: ${push.stderr.slice(0, 200)}`);
			} else {
				if (!isJsonMode()) printSuccess('schema pushed');
			}
		}

		// 5. Start the app (unless --no-app)
		if (!this.noApp) {
			const existingPid = readAppPid(ctx.cwd);
			if (existingPid) {
				if (!isJsonMode()) printInfo(`app already running (PID ${existingPid})`);
			} else {
				if (!isJsonMode()) printInfo('starting NestJS app...');
				const dbUrl = `postgres://postgres:postgres@localhost:${pgPort}/codegen_dev`;
				const redisUrl = `redis://localhost:${redisPort}`;
				const logFile = path.join(ctx.cwd, '.dev-app.log');
				const logFd = fs.openSync(logFile, 'a');

				const child = spawn('bun', ['src/main.ts'], {
					cwd: ctx.cwd,
					detached: true,
					stdio: ['ignore', logFd, logFd],
					env: {
						...process.env,
						DATABASE_URL: dbUrl,
						REDIS_URL: redisUrl,
						PORT: String(appPort),
					},
				});
				child.unref();
				fs.closeSync(logFd);

				if (child.pid) {
					writeAppPid(ctx.cwd, child.pid);
					// Wait briefly for app to start
					spawnSync('sleep', ['2']);
					const appStatus = checkApp(ctx.cwd, appPort);
					if (appStatus.healthy) {
						if (!isJsonMode()) printSuccess(`app running on port ${appPort} (PID ${child.pid})`);
					} else {
						if (!isJsonMode())
							printWarning(
								`app started (PID ${child.pid}) but not responding yet — check logs with: codegen dev logs`,
							);
					}
				}
			}
		}

		// 6. Show status
		if (isJsonMode()) {
			printJson({
				command: 'dev up',
				postgres: { port: pgPort, healthy: pgReady },
				redis: { port: redisPort, healthy: redisReady },
				app: this.noApp ? null : { port: appPort, pid: readAppPid(ctx.cwd) },
			});
		} else {
			console.log('');
			renderDevStatus(ctx);
		}

		return 0;
	}
}

// ---------------------------------------------------------------------------
// DevDownCommand
// ---------------------------------------------------------------------------

export class DevDownCommand extends Command {
	static paths = [['dev', 'down']];
	static usage = Command.Usage({
		description: 'Stop Docker services and the NestJS app',
	});

	volumes = Option.Boolean('--volumes,-v', false);
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		// Stop app
		const pid = readAppPid(ctx.cwd);
		if (pid) {
			try {
				process.kill(pid, 'SIGTERM');
				if (!isJsonMode()) printSuccess(`stopped app (PID ${pid})`);
			} catch {
				if (!isJsonMode()) printWarning(`app process ${pid} already gone`);
			}
			clearAppPid(ctx.cwd);
		}

		// Stop Docker
		const composePath = composeFilePath(ctx.cwd);
		const volFlag = this.volumes ? '-v' : '';
		const r = runCmd(
			`docker compose -f ${composePath} down ${volFlag}`.trim(),
			ctx.cwd,
		);
		if (r.ok) {
			if (!isJsonMode()) printSuccess('Docker services stopped');
		} else {
			printWarning(`docker compose down: ${r.stderr.slice(0, 200)}`);
		}

		if (isJsonMode()) {
			printJson({ command: 'dev down', ok: true });
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// DevStatusCommand
// ---------------------------------------------------------------------------

export class DevStatusCommand extends Command {
	static paths = [['dev', 'status']];
	static usage = Command.Usage({
		description: 'Show status of Docker services and the NestJS app',
	});

	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		if (isJsonMode()) {
			const pgPort = getPgPort(ctx);
			const redisPort = getRedisPort(ctx);
			const appPort = getAppPort(ctx);
			printJson({
				command: 'dev status',
				services: {
					postgres: checkPostgres(ctx.cwd, pgPort),
					redis: checkRedis(ctx.cwd, redisPort),
					app: checkApp(ctx.cwd, appPort),
				},
				entities: listEntityNames(ctx),
			});
			return 0;
		}

		renderDevStatus(ctx);
		return 0;
	}
}

// ---------------------------------------------------------------------------
// DevLogsCommand
// ---------------------------------------------------------------------------

export class DevLogsCommand extends Command {
	static paths = [['dev', 'logs']];
	static usage = Command.Usage({
		description: 'Tail application and Docker service logs',
		examples: [
			['Tail app logs', 'codegen dev logs'],
			['Tail Docker logs', 'codegen dev logs --docker'],
			['Show last N lines', 'codegen dev logs --tail 50'],
		],
	});

	docker = Option.Boolean('--docker', false);
	tail = Option.String('--tail', '30');
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		if (this.docker) {
			const composePath = composeFilePath(ctx.cwd);
			try {
				execSync(`docker compose -f ${composePath} logs --tail ${this.tail}`, {
					cwd: ctx.cwd,
					stdio: 'inherit',
				});
			} catch {
				printWarning('no Docker logs available');
			}
			return 0;
		}

		// App logs
		const logFile = path.join(ctx.cwd, '.dev-app.log');
		if (!fs.existsSync(logFile)) {
			printInfo('no app logs found — is the app running?');
			return 0;
		}

		try {
			execSync(`tail -n ${this.tail} ${logFile}`, { stdio: 'inherit' });
		} catch {
			printWarning('could not read app logs');
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// DevRestartCommand
// ---------------------------------------------------------------------------

export class DevRestartCommand extends Command {
	static paths = [['dev', 'restart']];
	static usage = Command.Usage({
		description: 'Restart the NestJS app (keep Docker services running)',
	});

	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		const appPort = getAppPort(ctx);
		const pgPort = getPgPort(ctx);
		const redisPort = getRedisPort(ctx);

		// Kill existing app
		const pid = readAppPid(ctx.cwd);
		if (pid) {
			try {
				process.kill(pid, 'SIGTERM');
				if (!isJsonMode()) printInfo(`stopped app (PID ${pid})`);
			} catch {
				// already gone
			}
			clearAppPid(ctx.cwd);
		}

		// Brief pause for port release
		spawnSync('sleep', ['1']);

		// Restart
		const dbUrl = `postgres://postgres:postgres@localhost:${pgPort}/codegen_dev`;
		const redisUrl = `redis://localhost:${redisPort}`;
		const logFile = path.join(ctx.cwd, '.dev-app.log');
		const logFd = fs.openSync(logFile, 'a');

		const child = spawn('bun', ['src/main.ts'], {
			cwd: ctx.cwd,
			detached: true,
			stdio: ['ignore', logFd, logFd],
			env: {
				...process.env,
				DATABASE_URL: dbUrl,
				REDIS_URL: redisUrl,
				PORT: String(appPort),
			},
		});
		child.unref();
		fs.closeSync(logFd);

		if (child.pid) {
			writeAppPid(ctx.cwd, child.pid);
			spawnSync('sleep', ['2']);
			const status = checkApp(ctx.cwd, appPort);
			if (status.healthy) {
				if (!isJsonMode()) printSuccess(`app restarted on port ${appPort} (PID ${child.pid})`);
			} else {
				if (!isJsonMode())
					printWarning(`app restarted (PID ${child.pid}) but not responding yet`);
			}
		}

		if (isJsonMode()) {
			printJson({ command: 'dev restart', pid: child.pid, port: appPort });
		}

		return 0;
	}
}

// ---------------------------------------------------------------------------
// Shared dashboard renderer
// ---------------------------------------------------------------------------

function renderDevStatus(ctx: Context): void {
	const pgPort = getPgPort(ctx);
	const redisPort = getRedisPort(ctx);
	const appPort = getAppPort(ctx);

	const pg = checkPostgres(ctx.cwd, pgPort);
	const redis = checkRedis(ctx.cwd, redisPort);
	const app = checkApp(ctx.cwd, appPort);
	const entities = listEntityNames(ctx);

	const body: string[] = [
		'Services:',
		`  ${formatServiceLine(pg)}`,
		`  ${formatServiceLine(redis)}`,
		`  ${formatServiceLine(app)}`,
		'',
		`Entities: ${entities.length > 0 ? `${entities.length} generated (${entities.join(', ')})` : 'none'}`,
	];

	// Check for endpoints if app is healthy
	if (app.healthy && entities.length > 0) {
		body.push('');
		body.push('Endpoints:');
		for (const name of entities) {
			const plural = name.endsWith('y')
				? name.slice(0, -1) + 'ies'
				: name.endsWith('s')
					? name + 'es'
					: name + 's';
			const r = runCmd(
				`curl -s -o /dev/null -w %{http_code} http://localhost:${appPort}/${plural}`,
				ctx.cwd,
				{ silent: true },
			);
			const code = r.stdout.trim();
			const ok = code.startsWith('2') || code.startsWith('3');
			const icon = ok ? theme.success(icons.check) : theme.error(icons.error);
			body.push(
				`  ${icon} GET  /${plural.padEnd(20)} ${ok ? theme.success(`${code} OK`) : theme.error(code || 'ERR')}`,
			);
		}
	}

	renderPane({ title: 'dev environment', body });
	renderHints([
		{ command: 'codegen dev logs', description: 'Tail application logs' },
		{ command: 'codegen dev logs --docker', description: 'Tail Docker service logs' },
		{ command: 'codegen dev restart', description: 'Restart the NestJS app' },
		{ command: 'codegen dev down', description: 'Stop everything' },
		{ command: '/dev-check', description: 'Run full health check with browser verification' },
		{ command: '/dev-test', description: 'Run test suite + endpoint verification' },
	]);
}

// ---------------------------------------------------------------------------
// summary + hints for NounModule
// ---------------------------------------------------------------------------

async function summary(ctx: Context): Promise<PaneOutput> {
	const pgPort = getPgPort(ctx);
	const redisPort = getRedisPort(ctx);
	const appPort = getAppPort(ctx);

	const pg = checkPostgres(ctx.cwd, pgPort);
	const redis = checkRedis(ctx.cwd, redisPort);
	const app = checkApp(ctx.cwd, appPort);
	const entities = listEntityNames(ctx);

	const running = [pg, redis, app].filter((s) => s.healthy).length;
	const total = 3;

	const body: string[] = [
		'Services:',
		`  ${formatServiceLine(pg)}`,
		`  ${formatServiceLine(redis)}`,
		`  ${formatServiceLine(app)}`,
		'',
		`Entities: ${entities.length > 0 ? `${entities.length} (${entities.join(', ')})` : 'none'}`,
	];

	return {
		title: 'dev environment',
		body,
		footer: `${running}/${total} services healthy`,
	};
}

async function hints(ctx: Context): Promise<Hint[]> {
	const app = checkApp(ctx.cwd, getAppPort(ctx));
	if (!app.healthy) {
		return [
			{ command: 'codegen dev up', description: 'Start dev environment' },
		];
	}
	return [
		{ command: 'codegen dev status', description: 'Show full status dashboard' },
		{ command: 'codegen dev logs', description: 'Tail application logs' },
		{ command: 'codegen dev restart', description: 'Restart the NestJS app' },
		{ command: 'codegen dev down', description: 'Stop everything' },
	];
}

// ---------------------------------------------------------------------------
// NounModule default export
// ---------------------------------------------------------------------------

const devNoun: NounModule = {
	name: 'dev',
	commandClasses: [
		DevUpCommand,
		DevDownCommand,
		DevStatusCommand,
		DevLogsCommand,
		DevRestartCommand,
	] as CommandClass[],
	summary,
	hints,
};

export default devNoun;
