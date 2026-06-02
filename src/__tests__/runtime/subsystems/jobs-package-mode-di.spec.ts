/**
 * Package-mode DI metadata regression (ADR-037).
 *
 * The published `@pattern-stack/codegen` bundle is built WITHOUT
 * `emitDecoratorMetadata` (tsup/esbuild default), so `design:paramtypes` is NOT
 * emitted. Any constructor param that relied on by-type reflection to inject a
 * CLASS (e.g. `ModuleRef`, `MemoryJobStore`) resolves to `undefined` at boot in
 * a package-mode consumer — breaking the jobs worker entirely (the
 * "JobWorkerModule: ModuleRef not available" throw).
 *
 * The fix makes every such injection EXPLICIT via `@Inject(<Class>)`, which
 * NestJS records under `self:paramtypes` (SELF_DECLARED_DEPS_METADATA) — a key
 * that is independent of `design:paramtypes` and therefore survives a bundle
 * built without decorator-metadata emission.
 *
 * These tests assert the explicit inject token is present for the params that
 * would otherwise depend on `design:paramtypes`, so a package build keeps DI
 * resolvable.
 */

import 'reflect-metadata';
import { describe, it, expect } from 'bun:test';
import { ModuleRef } from '@nestjs/core';

import {
	JobWorkerOrchestrator,
} from '../../../../runtime/subsystems/jobs/job-worker.module';
import { MemoryJobOrchestrator } from '../../../../runtime/subsystems/jobs/job-orchestrator.memory-backend';
import { MemoryJobRunService } from '../../../../runtime/subsystems/jobs/job-run-service.memory-backend';
import { MemoryJobStepService } from '../../../../runtime/subsystems/jobs/job-step-service.memory-backend';
import { MemoryJobStore } from '../../../../runtime/subsystems/jobs/memory-job-store';

const SELF_DECLARED_DEPS = 'self:paramtypes';

interface SelfDep {
	index: number;
	param: unknown;
}

function selfDeps(target: unknown): SelfDep[] {
	return (
		(Reflect.getMetadata(SELF_DECLARED_DEPS, target as object) as
			| SelfDep[]
			| undefined) ?? []
	);
}

/** The explicit inject token recorded for a constructor param `index`, or null. */
function injectTokenAt(target: unknown, index: number): unknown {
	const dep = selfDeps(target).find((d) => d.index === index);
	return dep ? dep.param : null;
}

describe('jobs package-mode DI metadata (ADR-037)', () => {
	it('JobWorkerOrchestrator injects ModuleRef via an explicit token (no design:paramtypes reliance)', () => {
		// Param index 5 is `moduleRef`. Without the explicit @Inject(ModuleRef)
		// this is absent from self:paramtypes and the package bundle (no
		// design:paramtypes) injects undefined → worker never boots.
		expect(injectTokenAt(JobWorkerOrchestrator, 5)).toBe(ModuleRef);
	});

	it('MemoryJobOrchestrator injects its class deps + ModuleRef explicitly', () => {
		// store (0), stepService (1), moduleRef (3) are class-typed and must be
		// explicit tokens.
		expect(injectTokenAt(MemoryJobOrchestrator, 0)).toBe(MemoryJobStore);
		expect(injectTokenAt(MemoryJobOrchestrator, 1)).toBe(MemoryJobStepService);
		expect(injectTokenAt(MemoryJobOrchestrator, 3)).toBe(ModuleRef);
	});

	it('MemoryJobRunService injects MemoryJobStore explicitly', () => {
		expect(injectTokenAt(MemoryJobRunService, 0)).toBe(MemoryJobStore);
	});

	it('MemoryJobStepService injects MemoryJobStore explicitly', () => {
		expect(injectTokenAt(MemoryJobStepService, 0)).toBe(MemoryJobStore);
	});
});
