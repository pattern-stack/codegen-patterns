/**
 * Unit tests for the F4 events-dir resolver.
 *
 * Covers the two cases:
 *   1. No config → `<cwd>/events` fallback
 *   2. `paths.events_dir` → configured path
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { resolveEventsDirFromConfig } from '../../cli/shared/events-path.js';
import type { CodegenConfig } from '../../cli/shared/context.js';

const CWD = '/tmp/events-path-fixture';

describe('resolveEventsDirFromConfig', () => {
	test('falls back to <cwd>/events when no config', () => {
		expect(resolveEventsDirFromConfig(CWD, null)).toBe(
			path.resolve(CWD, 'events'),
		);
	});

	test('honors paths.events_dir', () => {
		const config: CodegenConfig = { paths: { events_dir: 'custom/events' } };
		expect(resolveEventsDirFromConfig(CWD, config)).toBe(
			path.resolve(CWD, 'custom/events'),
		);
	});
});
