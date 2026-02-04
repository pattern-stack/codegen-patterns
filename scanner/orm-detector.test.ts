import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectORM } from './orm-detector.js';

const TEST_DIR = join(import.meta.dir, '__test-orm-detector__');

describe('detectORM', () => {
	beforeEach(() => {
		// Clean up test directory
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		// Clean up after tests
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
	});

	describe('Drizzle detection', () => {
		it('detects drizzle-orm imports', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'schema.ts'),
				`import { pgTable, text, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('drizzle');
			expect(result.confidence).toBeGreaterThan(0);
			expect(result.evidence.some(e => e.includes('imports drizzle-orm'))).toBe(true);
		});

		it('detects table definitions', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'users.schema.ts'),
				`export const users = pgTable('users', {
  id: integer('id').primaryKey(),
});`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('drizzle');
			expect(result.evidence.some(e => e.includes('table definition') || e.includes('schema file'))).toBe(true);
		});

		it('detects drizzle instance creation', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'db.ts'),
				`import { drizzle } from 'drizzle-orm/node-postgres';

export const db = drizzle(pool);`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('drizzle');
			expect(result.evidence.some(e => e.includes('drizzle instance'))).toBe(true);
		});

		it('detects .schema.ts files', async () => {
			const srcDir = join(TEST_DIR, 'src', 'schemas');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'user.schema.ts'),
				`export const userSchema = {};`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('drizzle');
			expect(result.evidence.some(e => e.includes('schema file'))).toBe(true);
		});
	});

	describe('Prisma detection', () => {
		it('detects prisma schema file (fast path)', async () => {
			const prismaDir = join(TEST_DIR, 'prisma');
			mkdirSync(prismaDir, { recursive: true });

			writeFileSync(
				join(prismaDir, 'schema.prisma'),
				`datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  name  String
}`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('prisma');
			expect(result.evidence).toContain('prisma/schema.prisma');
		});

		it('detects @prisma/client imports', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'db.ts'),
				`import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('prisma');
			expect(result.evidence.some(e => e.includes('@prisma/client'))).toBe(true);
		});

		it('detects PrismaClient instantiation', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'client.ts'),
				`const client = new PrismaClient({ log: ['query'] });`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('prisma');
			expect(result.evidence.some(e => e.includes('PrismaClient instantiation'))).toBe(true);
		});
	});

	describe('TypeORM detection', () => {
		it('detects typeorm imports', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'entity.ts'),
				`import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('typeorm');
			expect(result.evidence.some(e => e.includes('imports typeorm'))).toBe(true);
		});

		it('detects entity decorators', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'user.ts'),
				`@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('typeorm');
			expect(result.evidence.some(e => e.includes('entity decorators'))).toBe(true);
		});

		it('detects connection setup', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'data-source.ts'),
				`import { DataSource } from 'typeorm';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: 'localhost',
  port: 5432,
});`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('typeorm');
			expect(result.evidence.some(e => e.includes('connection setup'))).toBe(true);
		});
	});

	describe('No ORM detection', () => {
		it('returns none when no ORM patterns found', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			writeFileSync(
				join(srcDir, 'index.ts'),
				`export function hello() {
  console.log('Hello, world!');
}`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('none');
			expect(result.confidence).toBe(100);
			expect(result.evidence).toContain('No ORM-specific patterns detected');
		});

		it('handles missing directory gracefully', async () => {
			const nonExistentDir = join(TEST_DIR, 'does-not-exist');

			const result = await detectORM(nonExistentDir);

			expect(result.detected).toBe('none');
			expect(result.confidence).toBe(100);
		});
	});

	describe('Multiple ORMs (precedence)', () => {
		it('chooses ORM with most evidence', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			// Add strong Drizzle evidence
			writeFileSync(
				join(srcDir, 'schema1.ts'),
				`import { pgTable } from 'drizzle-orm/pg-core';`
			);
			writeFileSync(
				join(srcDir, 'schema2.ts'),
				`import { sqliteTable } from 'drizzle-orm/sqlite-core';`
			);
			writeFileSync(
				join(srcDir, 'db.ts'),
				`import { drizzle } from 'drizzle-orm';`
			);

			// Add weak Prisma evidence
			writeFileSync(
				join(srcDir, 'old-client.ts'),
				`// Old code: import { PrismaClient } from '@prisma/client';`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('drizzle');
		});
	});

	describe('Confidence calculation', () => {
		it('calculates confidence based on marker density', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			// Create multiple files with ORM markers
			for (let i = 0; i < 5; i++) {
				writeFileSync(
					join(srcDir, `schema${i}.ts`),
					`import { pgTable } from 'drizzle-orm/pg-core';`
				);
			}

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('drizzle');
			expect(result.confidence).toBeGreaterThan(0);
			expect(result.confidence).toBeLessThanOrEqual(100);
		});
	});

	describe('Directory skipping', () => {
		it('skips node_modules directory', async () => {
			const nodeModulesDir = join(TEST_DIR, 'node_modules', 'some-package');
			mkdirSync(nodeModulesDir, { recursive: true });

			writeFileSync(
				join(nodeModulesDir, 'index.ts'),
				`import { pgTable } from 'drizzle-orm/pg-core';`
			);

			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });
			writeFileSync(join(srcDir, 'app.ts'), `console.log('app');`);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('none');
		});

		it('skips dist and build directories', async () => {
			const distDir = join(TEST_DIR, 'dist');
			mkdirSync(distDir, { recursive: true });

			writeFileSync(
				join(distDir, 'index.js'),
				`// compiled code with drizzle-orm`
			);

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('none');
		});
	});

	describe('Evidence limiting', () => {
		it('limits evidence to 10 examples', async () => {
			const srcDir = join(TEST_DIR, 'src');
			mkdirSync(srcDir, { recursive: true });

			// Create 15 files with markers
			for (let i = 0; i < 15; i++) {
				writeFileSync(
					join(srcDir, `schema${i}.ts`),
					`import { pgTable } from 'drizzle-orm/pg-core';`
				);
			}

			const result = await detectORM(TEST_DIR);

			expect(result.detected).toBe('drizzle');
			expect(result.evidence.length).toBeLessThanOrEqual(10);
		});
	});
});
