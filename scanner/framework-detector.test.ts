/**
 * Framework Detector Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectFramework } from './framework-detector.js';

const TEST_DIR = join(process.cwd(), 'tools/codegen/scanner/__test_temp__');

describe('detectFramework', () => {
	beforeEach(() => {
		// Clean up and create test directory
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
	});

	it('detects NestJS from decorators', async () => {
		// Create a NestJS controller file
		const srcDir = join(TEST_DIR, 'src');
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(
			join(srcDir, 'app.controller.ts'),
			`
import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getHello(): string {
    return 'Hello World!';
  }
}
`
		);

		writeFileSync(
			join(srcDir, 'app.module.ts'),
			`
import { Module } from '@nestjs/core';

@Module({
  imports: [],
})
export class AppModule {}
`
		);

		const result = await detectFramework(TEST_DIR);

		expect(result.detected).toBe('nestjs');
		expect(result.confidence).toBeGreaterThan(0);
		expect(result.evidence.length).toBeGreaterThan(0);
		expect(result.evidence.some((e) => e.includes('app.controller.ts'))).toBe(true);
	});

	it('detects Fastify from instantiation patterns', async () => {
		const srcDir = join(TEST_DIR, 'src');
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(
			join(srcDir, 'server.ts'),
			`
import fastify from 'fastify';

const app = fastify();

app.register(async (instance) => {
  instance.get('/', async () => {
    return { hello: 'world' };
  });
});
`
		);

		const result = await detectFramework(TEST_DIR);

		expect(result.detected).toBe('fastify');
		expect(result.confidence).toBeGreaterThan(0);
		expect(result.evidence.length).toBeGreaterThan(0);
		expect(result.evidence.some((e) => e.includes('server.ts'))).toBe(true);
	});

	it('detects Express from app patterns', async () => {
		const srcDir = join(TEST_DIR, 'src');
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(
			join(srcDir, 'server.ts'),
			`
import express from 'express';

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ hello: 'world' });
});

app.post('/users', (req, res) => {
  res.json({ created: true });
});
`
		);

		const result = await detectFramework(TEST_DIR);

		expect(result.detected).toBe('express');
		expect(result.confidence).toBeGreaterThan(0);
		expect(result.evidence.length).toBeGreaterThan(0);
		expect(result.evidence.some((e) => e.includes('server.ts'))).toBe(true);
	});

	it('returns plain when no framework detected', async () => {
		const srcDir = join(TEST_DIR, 'src');
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(
			join(srcDir, 'utils.ts'),
			`
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`
		);

		const result = await detectFramework(TEST_DIR);

		expect(result.detected).toBe('plain');
		expect(result.confidence).toBeGreaterThanOrEqual(0);
		expect(result.evidence).toContain('No framework-specific patterns detected');
	});

	it('handles empty directories gracefully', async () => {
		const result = await detectFramework(TEST_DIR);

		expect(result.detected).toBe('plain');
		expect(result.confidence).toBe(0);
		expect(result.evidence).toContain('No TypeScript files found');
	});

	it('handles non-existent directories gracefully', async () => {
		const nonExistentDir = join(TEST_DIR, 'does-not-exist');
		const result = await detectFramework(nonExistentDir);

		expect(result.detected).toBe('plain');
		expect(result.confidence).toBe(0);
		expect(result.evidence).toContain('No TypeScript files found');
	});

	it('skips node_modules directory', async () => {
		const srcDir = join(TEST_DIR, 'src');
		const nodeModulesDir = join(TEST_DIR, 'node_modules', '@nestjs', 'common');
		mkdirSync(srcDir, { recursive: true });
		mkdirSync(nodeModulesDir, { recursive: true });

		// Create plain file in src
		writeFileSync(
			join(srcDir, 'utils.ts'),
			`export const hello = 'world';`
		);

		// Create NestJS file in node_modules (should be ignored)
		writeFileSync(
			join(nodeModulesDir, 'index.ts'),
			`
import { Controller } from '@nestjs/common';
@Controller()
export class TestController {}
`
		);

		const result = await detectFramework(TEST_DIR);

		expect(result.detected).toBe('plain');
	});

	it('prioritizes framework with most markers', async () => {
		const srcDir = join(TEST_DIR, 'src');
		mkdirSync(srcDir, { recursive: true });

		// Create multiple NestJS files
		writeFileSync(
			join(srcDir, 'app.controller.ts'),
			`
import { Controller, Get } from '@nestjs/common';
@Controller()
export class AppController {
  @Get() getHello() {}
}
`
		);

		writeFileSync(
			join(srcDir, 'app.service.ts'),
			`
import { Injectable } from '@nestjs/common';
@Injectable()
export class AppService {}
`
		);

		writeFileSync(
			join(srcDir, 'app.module.ts'),
			`
import { Module } from '@nestjs/core';
@Module({})
export class AppModule {}
`
		);

		// Create one Express file
		writeFileSync(
			join(srcDir, 'legacy.ts'),
			`
import express from 'express';
const app = express();
`
		);

		const result = await detectFramework(TEST_DIR);

		// Should detect NestJS since it has more markers
		expect(result.detected).toBe('nestjs');
		expect(result.confidence).toBeGreaterThan(0);
	});

	it('calculates confidence based on marker density', async () => {
		const srcDir = join(TEST_DIR, 'src');
		mkdirSync(srcDir, { recursive: true });

		// Create 10 plain files
		for (let i = 0; i < 10; i++) {
			writeFileSync(
				join(srcDir, `utils${i}.ts`),
				`export const value${i} = ${i};`
			);
		}

		// Create 1 NestJS file with multiple markers
		writeFileSync(
			join(srcDir, 'app.controller.ts'),
			`
import { Controller, Get, Post, Put } from '@nestjs/common';
@Controller()
export class AppController {
  @Get() getHello() {}
  @Post() postHello() {}
  @Put() putHello() {}
}
`
		);

		const result = await detectFramework(TEST_DIR);

		expect(result.detected).toBe('nestjs');
		// With 1 file with 7+ markers out of 11 files, confidence should be reasonable
		expect(result.confidence).toBeGreaterThan(0);
		expect(result.confidence).toBeLessThanOrEqual(100);
	});

	it('includes relative file paths in evidence', async () => {
		const srcDir = join(TEST_DIR, 'src', 'controllers');
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(
			join(srcDir, 'user.controller.ts'),
			`
import { Controller } from '@nestjs/common';
@Controller('users')
export class UserController {}
`
		);

		const result = await detectFramework(TEST_DIR);

		expect(result.detected).toBe('nestjs');
		// Evidence should contain relative path without leading slash
		expect(result.evidence.some((e) =>
			e.includes('src/controllers/user.controller.ts')
		)).toBe(true);
	});
});
