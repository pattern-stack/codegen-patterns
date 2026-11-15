/**
 * Wire `SUBSYSTEM_MODULES` into a smoke project's AppModule — shared by every smoke that boots a subsystem.
 *
 * The CLI's `subsystem install` intentionally LEAVES this wiring as a manual step: it prints a TODO and relies on the
 * user to spread `...SUBSYSTEM_MODULES` into `AppModule.imports`. So an installed subsystem's providers (e.g.
 * `TYPED_EVENT_BUS`) are not in the module graph until a harness does what a user does. A smoke whose boot check
 * must resolve them applies that wiring here.
 *
 * The patch (idempotent):
 *   - adds `import { SUBSYSTEM_MODULES } from './generated/subsystems';`
 *   - spreads `...SUBSYSTEM_MODULES,` into the `imports` array immediately after `OpenApiModule,`, which honours the
 *     registration-order constraint of the `subsystems` skill (Database first → OpenApi → SubsystemModules →
 *     the rest, Generated last).
 *
 * It THROWS when the AppModule's shape has drifted and the spread did not land: a no-op patch would leave the boot
 * check failing on a missing provider, far from the cause.
 */

import fs from 'node:fs';
import path from 'node:path';

export function composeSubsystemModules(tmpDir: string): void {
	const appModulePath = path.join(tmpDir, 'src', 'app.module.ts');
	let src = fs.readFileSync(appModulePath, 'utf-8');
	if (!src.includes('SUBSYSTEM_MODULES')) {
		src = `import { SUBSYSTEM_MODULES } from './generated/subsystems';\n${src}`;
		// The init-emitted template reads `imports: [DatabaseModule, OpenApiModule, ...GENERATED_MODULES]`; a smoke
		// may put other modules (auth) between them.
		src = src.replace(/(imports:\s*\[[^\]]*?\bOpenApiModule,)/, '$1 ...SUBSYSTEM_MODULES,');
		fs.writeFileSync(appModulePath, src, 'utf-8');
	}
	if (!fs.readFileSync(appModulePath, 'utf-8').includes('...SUBSYSTEM_MODULES')) {
		throw new Error(
			'failed to wire SUBSYSTEM_MODULES into app.module.ts — the imports-array pattern did not match (after `OpenApiModule,`). The init template may have drifted.',
		);
	}
}
