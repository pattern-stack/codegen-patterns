/**
 * #226-7 — Template rendering + typecheck for the per-entity sync-source
 * factory module.
 *
 * Two layers of verification:
 *   1. EJS rendering with representative locals from the opportunity
 *      fixture — asserts the expected import + provider shape.
 *   2. `tsc --noEmit` over the rendered file with stub modules standing
 *      in for `@shared/subsystems/sync` and the entity domain class.
 *      Fulfills the `#226-7` acceptance "generated module compiles in a
 *      fresh project" without standing up the full smoke harness for the
 *      clean-architecture pipeline.
 *
 * The smoke harness (`test/smoke/run-smoke.ts`) currently exercises only
 * the clean-lite-ps architecture. Adding clean-arch coverage to it is a
 * larger refactor tracked as a follow-up; this targeted test gives us the
 * compile gate the AC requires today.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const TEMPLATE_PATH = resolve(
	REPO_ROOT,
	'templates/entity/new/backend/modules/core/sync-source.ejs.t',
);

function extractBody(source: string): string {
	const lines = source.split('\n');
	if (lines[0] !== '---') return source;
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === '---') {
			end = i;
			break;
		}
	}
	if (end === -1) return source;
	return lines.slice(end + 1).join('\n');
}

function opportunityLocals() {
	return {
		className: 'Opportunity',
		hasDetection: true,
		isCleanArchitecture: true,
		syncAdapterToken: 'OPPORTUNITY_SYNC_ADAPTER',
		syncLoopbackToken: 'OPPORTUNITY_SYNC_LOOPBACK_STORE',
		syncSourceModuleClass: 'OpportunitySyncSourceModule',
		syncSourceToEntityImport: '../domain/opportunity/opportunity.entity',
		detectionConfigJson: JSON.stringify(
			{
				mode: 'poll',
				poll: { cursor: { kind: 'systemModstamp', field: 'SystemModstamp' } },
				mapping: [
					{ source: 'Id', target: 'external_id' },
					{ source: 'Name', target: 'name' },
				],
				filters: [{ field: 'IsDeleted', op: 'eq', value: false }],
			},
			null,
			2,
		),
		outputPaths: { syncSourceModule: 'irrelevant.ts' },
	};
}

function render(): string {
	const body = extractBody(readFileSync(TEMPLATE_PATH, 'utf8'));
	return ejs.render(body, opportunityLocals(), { rmWhitespace: false });
}

describe('sync-source template — EJS rendering', () => {
	const out = render();

	test('imports the runtime sync barrel + entity class', () => {
		expect(out).toContain("from '@shared/subsystems/sync'");
		expect(out).toContain("import { Opportunity } from '../domain/opportunity/opportunity.entity'");
	});

	test('declares the consumer-side adapter + optional loopback tokens', () => {
		expect(out).toContain("export const OPPORTUNITY_SYNC_ADAPTER = 'OPPORTUNITY_SYNC_ADAPTER'");
		expect(out).toContain(
			"export const OPPORTUNITY_SYNC_LOOPBACK_STORE = 'OPPORTUNITY_SYNC_LOOPBACK_STORE'",
		);
	});

	test('binds SYNC_CHANGE_SOURCE via factory with optional loopback inject', () => {
		expect(out).toContain('provide: SYNC_CHANGE_SOURCE');
		expect(out).toContain('useFactory:');
		expect(out).toContain('new PollChangeSource<Opportunity>');
		expect(out).toContain(
			'{ token: OPPORTUNITY_SYNC_LOOPBACK_STORE, optional: true }',
		);
	});

	test('inlines the parsed detection config literal', () => {
		expect(out).toContain('"mode": "poll"');
		expect(out).toContain('"target": "external_id"');
	});

	test('exports a NestJS module class with the expected name', () => {
		expect(out).toContain('export class OpportunitySyncSourceModule');
	});
});

// ---------------------------------------------------------------------------
// tsc --noEmit gate — proves the generated file is syntactically + type-
// correct against a stub of the runtime sync barrel and the entity class.
// ---------------------------------------------------------------------------

describe('sync-source template — typechecks against runtime stubs', () => {
	const tempDirs: string[] = [];

	afterAll(() => {
		for (const d of tempDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	});

	function runTsc(): { exitCode: number; output: string } {
		// Place the tmp dir INSIDE the repo so Node's module-resolution walks
		// up to the repo's node_modules and finds @nestjs/* + @types/node.
		// Mirrors the pattern used by event-codegen-generator.test.ts.
		const tmpBase = join(REPO_ROOT, 'test', 'tmp', 'sync-source-emit-tsc');
		mkdirSync(tmpBase, { recursive: true });
		const dir = mkdtempSync(join(tmpBase, 'case-'));
		tempDirs.push(dir);

		// Mirror the generated module's directory layout: a `modules/`
		// dir that imports `../domain/opportunity/opportunity.entity` and
		// the `@shared/subsystems/sync` barrel.
		const modulesDir = join(dir, 'modules');
		const domainDir = join(dir, 'domain', 'opportunity');
		const sharedSyncDir = join(dir, 'shared', 'subsystems', 'sync');
		mkdirSync(modulesDir, { recursive: true });
		mkdirSync(domainDir, { recursive: true });
		mkdirSync(sharedSyncDir, { recursive: true });

		writeFileSync(
			join(modulesDir, 'opportunity-sync-source.module.ts'),
			render(),
		);

		// Minimal entity stub.
		writeFileSync(
			join(domainDir, 'opportunity.entity.ts'),
			'export class Opportunity {}\n',
		);

		// Stub barrel mirroring the runtime exports the template depends
		// on. Types-only — no implementation. Asserts the generated module
		// uses each symbol with a compatible shape.
		writeFileSync(
			join(sharedSyncDir, 'index.ts'),
			[
				"export const SYNC_CHANGE_SOURCE = 'SYNC_CHANGE_SOURCE' as const;",
				'export type DetectionConfig = unknown;',
				'export type ChangeMiddleware<T> = (next: unknown) => unknown;',
				'export type ILoopbackFingerprintStore<T> = {',
				'  isEchoOfOwnWrite(t: string, id: string, r: T): Promise<boolean>;',
				'};',
				'export type PollFetchCallback<T> = (ctx: unknown) => AsyncIterable<{ record: T; cursor: unknown }>;',
				'export class PollChangeSource<T> {',
				'  constructor(_opts: {',
				'    adapter: PollFetchCallback<T>;',
				'    config: DetectionConfig;',
				'    middlewares?: ReadonlyArray<ChangeMiddleware<T>>;',
				'  }) {}',
				'}',
				'export function createLoopbackMiddleware<T>(',
				'  _store: ILoopbackFingerprintStore<T>,',
				'): ChangeMiddleware<T> { return (n) => n; }',
			].join('\n') + '\n',
		);

		writeFileSync(
			join(dir, 'tsconfig.json'),
			JSON.stringify(
				{
					compilerOptions: {
						lib: ['ESNext'],
						target: 'ESNext',
						module: 'Preserve',
						moduleDetection: 'force',
						moduleResolution: 'bundler',
						allowImportingTsExtensions: true,
						verbatimModuleSyntax: false,
						noEmit: true,
						strict: true,
						skipLibCheck: true,
						experimentalDecorators: true,
						emitDecoratorMetadata: true,
						ignoreDeprecations: '6.0',
						baseUrl: '.',
						paths: {
							'@shared/*': ['shared/*'],
						},
					},
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(dir, 'package.json'),
			'{"name":"sync-source-emit-tsc"}\n',
		);

		const res = spawnSync('bunx', ['--bun', 'tsc', '--noEmit', '-p', dir], {
			cwd: REPO_ROOT,
			encoding: 'utf-8',
			timeout: 60_000,
		});
		return {
			exitCode: res.status ?? -1,
			output: (res.stdout ?? '') + (res.stderr ?? ''),
		};
	}

	test('rendered module typechecks against runtime stubs (#226-7 AC)', () => {
		const { exitCode, output } = runTsc();
		if (exitCode !== 0) {
			throw new Error(`tsc exited ${exitCode}:\n${output}`);
		}
		expect(exitCode).toBe(0);
	});
});
