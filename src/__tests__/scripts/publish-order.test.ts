/**
 * `scripts/publish-order.ts`: the publishable packages in build order, the one list `just publish-ci` and the tarball
 * smoke read. Main's publish failed when the root built before `@pattern-stack/jobs`, whose dist its runtime imports.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { publishOrder } from '../../../scripts/publish-order';

const REPO = path.resolve(import.meta.dir, '../../..');
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('the publish order', () => {
	it('builds @pattern-stack/jobs before the root, and the root before every surface package', () => {
		const names = publishOrder(REPO).map((p) => p.name);
		expect(names.indexOf('@pattern-stack/jobs')).toBeLessThan(names.indexOf('@pattern-stack/codegen'));
		for (const surface of names.filter((n) => n.startsWith('@pattern-stack/codegen-'))) {
			expect(names.indexOf('@pattern-stack/codegen')).toBeLessThan(names.indexOf(surface));
		}
		// Not opted in (private, or no publishConfig.access: public): not built or published.
		expect(names).not.toContain('@pattern-stack/graph-components');
	});

	it('follows the manifests: a new package the root names is ordered before it, and a cycle is refused by name', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-order-'));
		dirs.push(root);
		const write = (dir: string, manifest: object) => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
		};
		const pub = { publishConfig: { access: 'public' } };
		write(root, { name: 'app', version: '1.0.0', peerDependencies: { wiring: '*' }, devDependencies: { surface: '*' } });
		write(path.join(root, 'packages/a-surface'), { name: 'surface', version: '1.0.0', peerDependencies: { app: '*' }, ...pub });
		write(path.join(root, 'packages/wiring'), { name: 'wiring', version: '1.0.0', ...pub });
		expect(publishOrder(root).map((p) => p.name)).toEqual(['wiring', 'app', 'surface']);

		write(path.join(root, 'packages/wiring'), { name: 'wiring', version: '1.0.0', dependencies: { surface: '*' }, ...pub });
		expect(() => publishOrder(root)).toThrow(/cycle: .*app → wiring → surface → app/);
	});
});
