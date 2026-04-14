/**
 * Tests for the semantic output helpers (ADR-016 / SPEC-CLI-01).
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { printSuccess, printError, printWarning, printInfo, printMuted } from '../../cli/ui/output.js';
import { setJsonMode } from '../../cli/ui/json.js';

function captureStdout(): { restore: () => string } {
	const original = console.log;
	const chunks: string[] = [];
	console.log = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' '));
	};
	return {
		restore: () => {
			console.log = original;
			return chunks.join('\n');
		},
	};
}

function captureStderr(): { restore: () => string } {
	const original = console.error;
	const chunks: string[] = [];
	console.error = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' '));
	};
	return {
		restore: () => {
			console.error = original;
			return chunks.join('\n');
		},
	};
}

function captureWarn(): { restore: () => string } {
	const original = console.warn;
	const chunks: string[] = [];
	console.warn = (...args: unknown[]) => {
		chunks.push(args.map((a) => String(a)).join(' '));
	};
	return {
		restore: () => {
			console.warn = original;
			return chunks.join('\n');
		},
	};
}

describe('output helpers', () => {
	beforeEach(() => setJsonMode(false));
	afterEach(() => setJsonMode(false));

	test('printSuccess writes to stdout', () => {
		const cap = captureStdout();
		printSuccess('done');
		const output = cap.restore();
		expect(output).toContain('done');
	});

	test('printError writes to stderr and truncates long messages', () => {
		const cap = captureStderr();
		const long = 'x'.repeat(600);
		printError(long);
		const output = cap.restore();
		expect(output.length).toBeLessThan(600 + 20); // truncated + icon + space
		expect(output).toContain('…');
	});

	test('printWarning writes to stderr via console.warn', () => {
		const cap = captureWarn();
		printWarning('careful');
		const output = cap.restore();
		expect(output).toContain('careful');
	});

	test('printInfo and printMuted write to stdout', () => {
		const cap = captureStdout();
		printInfo('i');
		printMuted('m');
		const output = cap.restore();
		expect(output).toContain('i');
		expect(output).toContain('m');
	});

	test('all helpers no-op in json mode', () => {
		setJsonMode(true);
		const outCap = captureStdout();
		const errCap = captureStderr();
		const warnCap = captureWarn();
		printSuccess('a');
		printError('b');
		printWarning('c');
		printInfo('d');
		printMuted('e');
		expect(outCap.restore()).toBe('');
		expect(errCap.restore()).toBe('');
		expect(warnCap.restore()).toBe('');
	});
});
