/**
 * Where the integration layer's files are (S-3): one function per file, read by the plan, the emit, the scaffolds that
 * import each other, and stale-files. Pure path arithmetic: no fs, no other module of the integration generators.
 */
import { join } from 'node:path';

import { emittedStem } from './file-naming.js';

/** `<backend_src>/integrations`: the root every integration file sits under. */
export function integrationsRoot(layout: { backendSrc: string }): string {
	return join(layout.backendSrc, 'integrations');
}

/** `<root>/module.ts`: the `integrations` module (the runs), which the composition writes. */
export function integrationsModuleFile(root: string): string {
	return join(root, 'module.ts');
}

/** `<root>/providers/<slug>/<slug>.provider.ts`: the provider's system (@generated). */
export function providerSystemFile(root: string, slug: string): string {
	return join(root, 'providers', slug, `${slug}.provider.ts`);
}

/** `<root>/providers/<slug>/<slug>.provider.factory.ts`: where the author builds the provider's parts (emit-once). */
export function providerFactoryFile(root: string, slug: string): string {
	return join(root, 'providers', slug, `${slug}.provider.factory.ts`);
}

/** `<root>/<surface>/<surface>-adapters.system.ts`: the surface's adapters system (@generated). */
export function adaptersSystemFile(root: string, surface: string): string {
	return join(root, surface, `${surface}-adapters.system.ts`);
}

/** `<root>/<surface>/adapters/<slug>/<slug>-<surface>.adapter.ts`: a provider's adapter scaffold (emit-once). */
export function adapterScaffoldFile(root: string, surface: string, slug: string): string {
	return join(root, surface, 'adapters', slug, `${slug}-${surface}.adapter.ts`);
}

/** `<root>/<surface>/types.generated.ts`: the surface's typed view (@generated). */
export function typedViewFile(root: string, surface: string): string {
	return join(root, surface, 'types.generated.ts');
}

/** An Integrated entity's sink files in `<root>/<surface>/sinks/`: the @generated base, the subclass, the change emitter. */
export function sinkFiles(root: string, surface: string, entity: string): { dir: string; base: string; sink: string; emitter: string } {
	const dir = join(root, surface, 'sinks');
	const stem = emittedStem(entity);
	return {
		dir,
		base: join(dir, `${stem}.sink.generated.ts`),
		sink: join(dir, `${stem}.sink.ts`),
		emitter: join(dir, `${stem}.change-emitter.ts`),
	};
}
