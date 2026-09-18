/**
 * JOBS-1 (#660) — every `entity new` post-step emitter names the file it could
 * not write. Each case occupies one output path with a directory (a real
 * `EISDIR`, no mocks) and asserts a `GeneratedFileError` for exactly that file;
 * the CLI turns it into exit 1 (`regeneration-failure.test.ts`).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { emitAdapters } from '../../cli/shared/adapter-emission-generator';
import { emitJobHandlers } from '../../cli/shared/emit-jobs';
import { generateOrchestrationModules } from '../../cli/shared/orchestration-generator';
import { generateProviderModules } from '../../cli/shared/provider-module-generator';
import { writeFile } from '../../emitters/frontend/emit-utils';
import { JobDefinitionSchema } from '../../schema/job-definition.schema';
import { GeneratedFileError, generating } from '../../utils/generated-file';
import { loadProviderFromYaml } from '../../utils/yaml-loader';
import { CrmPortsPattern } from '../patterns/fixtures/orchestration/valid-crm-ports.pattern.ts';

const PARSER_FIX = resolve(import.meta.dir, '../parser/fixtures');

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), 'emit-fail-'));
	tmpDirs.push(d);
	return d;
}
/** Occupy `file` with a directory so writing it fails with EISDIR. */
function block(file: string): string {
	mkdirSync(file, { recursive: true });
	return file;
}
function expectNamed(step: () => unknown, file: string): void {
	let caught: unknown;
	try {
		step();
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(GeneratedFileError);
	expect((caught as GeneratedFileError).file).toBe(file);
	expect((caught as Error).message).toContain(`could not regenerate ${file}: EISDIR`);
}

describe('generating', () => {
	test('names the file for a sync throw and an async rejection; a nested error passes through', async () => {
		expect(() => generating('/a', () => { throw new Error('boom'); })).toThrow('could not regenerate /a: boom');
		await expect(generating('/b', async () => { throw new Error('late'); })).rejects.toThrow(
			'could not regenerate /b: late',
		);
		const inner = new GeneratedFileError('/inner', new Error('x'));
		expect(() => generating('/outer', () => { throw inner; })).toThrow(inner);
	});
});

describe('post-step emitters name the file they could not write', () => {
	test('job handlers — the @generated base', () => {
		const dir = tmp();
		const job = JobDefinitionSchema.parse(
			parseYaml(readFileSync(resolve(import.meta.dir, '../../../test/fixtures/jobs/drive_poll.yaml'), 'utf8')),
		);
		const file = block(join(dir, 'drive_poll.job.generated.ts'));
		expectNamed(() => emitJobHandlers({ jobs: [job], jobsHandlersDir: dir }), file);
	});

	test('orchestration — a per-pattern file', () => {
		const outputRoot = tmp();
		const plan = generateOrchestrationModules({ patterns: [CrmPortsPattern], outputRoot, dryRun: true });
		const file = block(plan.patterns[0]!.files[0]!.outputPath);
		expectNamed(() => generateOrchestrationModules({ patterns: [CrmPortsPattern], outputRoot }), file);
	});

	test('frontend — the shared writer', () => {
		const file = block(join(tmp(), 'store', 'index.ts'));
		expectNamed(() => writeFile(file, 'x'), file);
	});

	test('provider modules', () => {
		const outputRoot = tmp();
		const file = block(join(outputRoot, 'google/google.provider.module.ts'));
		const provSrc = resolve(PARSER_FIX, 'provider-src');
		expectNamed(
			() =>
				generateProviderModules({
					providersDir: resolve(PARSER_FIX, 'providers'),
					outputRoot,
					entitySurfaces: new Set(['calendar', 'mail', 'transcript', 'crm']),
					sourceRoot: provSrc,
					aliases: { '@app': provSrc },
				}),
			file,
		);
	});

	test('adapters / assembly', () => {
		const outputRoot = tmp();
		const file = block(join(outputRoot, 'crm/crm-adapters.module.ts'));
		const hubspot = resolve(PARSER_FIX, 'providers/hubspot.yaml');
		const loaded = loadProviderFromYaml(hubspot);
		if (!loaded.success) throw new Error('hubspot fixture failed to load');
		expectNamed(
			() =>
				emitAdapters({
					providers: [{ definition: loaded.definition, filePath: hubspot }],
					entities: [{ entity: { name: 'deal', surface: 'crm' } }],
					outputRoot,
				}),
			file,
		);
	});
});
