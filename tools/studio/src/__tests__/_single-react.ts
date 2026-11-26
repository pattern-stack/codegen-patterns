/**
 * Test preload (bunfig.toml `[test] preload`): one React for the whole run.
 *
 * The component library (`packages/graph-components`) is read from source (tsconfig `paths`), so its own `react`
 * import resolves to a second copy under the library's node_modules, whose hooks have no dispatcher inside this app's
 * renderer ("Invalid hook call"). The library's copy is pointed at this app's one HERE, before any test file loads —
 * not in each file that renders a hook: `bun test` runs every file in one process, in directory order, so a file that
 * merely imports the library (e.g. `selector.test.ts` → `../graph/selector`) and runs first would load it bound to the
 * second copy, and a later file's mock would come too late. Linux's directory order made that a CI-only failure.
 */
import { mock } from 'bun:test';
import * as React from 'react';
import { createRequire } from 'node:module';
import path from 'node:path';

const libraryDir = path.resolve(import.meta.dir, '../../../../packages/graph-components/src');
mock.module(createRequire(path.join(libraryDir, 'index.ts')).resolve('react'), () => React);
