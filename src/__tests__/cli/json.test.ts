/**
 * Tests for JSON mode flag + printJson helper.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { isJsonMode, setJsonMode, printJson } from '../../cli/ui/json.js';

describe('json mode', () => {
	afterEach(() => setJsonMode(false));

	test('isJsonMode toggles with setJsonMode', () => {
		expect(isJsonMode()).toBe(false);
		setJsonMode(true);
		expect(isJsonMode()).toBe(true);
		setJsonMode(false);
		expect(isJsonMode()).toBe(false);
	});

	test('printJson writes structured payload to stdout', () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((data: string | Uint8Array) => {
			chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
			return true;
		}) as typeof process.stdout.write;

		try {
			printJson({ noun: 'entity', count: 2 });
		} finally {
			process.stdout.write = original;
		}

		const parsed = JSON.parse(chunks.join(''));
		expect(parsed.noun).toBe('entity');
		expect(parsed.count).toBe(2);
	});
});
