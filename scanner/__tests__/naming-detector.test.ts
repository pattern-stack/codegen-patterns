import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectNaming } from '../naming-detector.js';

const TEST_ROOT = join(import.meta.dir, 'fixtures', 'naming-test');

describe('detectNaming', () => {
	afterAll(() => {
		// Cleanup test fixtures
		if (existsSync(TEST_ROOT)) {
			rmSync(TEST_ROOT, { recursive: true });
		}
	});

	describe('case detection', () => {
		it('detects kebab-case files', async () => {
			const testDir = join(TEST_ROOT, 'kebab-case');
			mkdirSync(testDir, { recursive: true });

			// Create kebab-case files
			writeFileSync(join(testDir, 'user-service.ts'), '');
			writeFileSync(join(testDir, 'get-by-id.query.ts'), '');
			writeFileSync(join(testDir, 'create-user.command.ts'), '');

			const result = await detectNaming(testDir);

			expect(result.fileCase.detected).toBe('kebab-case');
			expect(result.fileCase.confidence).toBeGreaterThan(80);
		});

		it('detects camelCase files', async () => {
			const testDir = join(TEST_ROOT, 'camelCase');
			mkdirSync(testDir, { recursive: true });

			// Create camelCase files
			writeFileSync(join(testDir, 'userService.ts'), '');
			writeFileSync(join(testDir, 'getById.ts'), '');
			writeFileSync(join(testDir, 'createUser.ts'), '');

			const result = await detectNaming(testDir);

			expect(result.fileCase.detected).toBe('camelCase');
			expect(result.fileCase.confidence).toBeGreaterThan(80);
		});

		it('detects PascalCase files', async () => {
			const testDir = join(TEST_ROOT, 'PascalCase');
			mkdirSync(testDir, { recursive: true });

			// Create PascalCase files
			writeFileSync(join(testDir, 'UserService.ts'), '');
			writeFileSync(join(testDir, 'GetById.ts'), '');
			writeFileSync(join(testDir, 'CreateUser.ts'), '');

			const result = await detectNaming(testDir);

			expect(result.fileCase.detected).toBe('PascalCase');
			expect(result.fileCase.confidence).toBeGreaterThan(80);
		});

		it('detects snake_case files', async () => {
			const testDir = join(TEST_ROOT, 'snake_case');
			mkdirSync(testDir, { recursive: true });

			// Create snake_case files
			writeFileSync(join(testDir, 'user_service.ts'), '');
			writeFileSync(join(testDir, 'get_by_id.ts'), '');
			writeFileSync(join(testDir, 'create_user.ts'), '');

			const result = await detectNaming(testDir);

			expect(result.fileCase.detected).toBe('snake_case');
			expect(result.fileCase.confidence).toBeGreaterThan(80);
		});

		it('ignores test files', async () => {
			const testDir = join(TEST_ROOT, 'ignore-tests');
			mkdirSync(testDir, { recursive: true });

			// Create regular files
			writeFileSync(join(testDir, 'user-service.ts'), '');
			// Create test files (should be ignored)
			writeFileSync(join(testDir, 'user-service.test.ts'), '');
			writeFileSync(join(testDir, 'user-service.spec.ts'), '');
			writeFileSync(join(testDir, 'types.d.ts'), '');

			const result = await detectNaming(testDir);

			// Should only detect kebab-case from user-service.ts
			expect(result.fileCase.detected).toBe('kebab-case');
		});
	});

	describe('suffix detection', () => {
		it('detects common suffixes', async () => {
			const testDir = join(TEST_ROOT, 'suffixes');
			mkdirSync(testDir, { recursive: true });

			// Create files with various suffixes
			writeFileSync(join(testDir, 'user.entity.ts'), '');
			writeFileSync(join(testDir, 'user.service.ts'), '');
			writeFileSync(join(testDir, 'user.controller.ts'), '');
			writeFileSync(join(testDir, 'user.repository.ts'), '');
			writeFileSync(join(testDir, 'user.dto.ts'), '');

			const result = await detectNaming(testDir);

			expect(result.suffixes).toContain('.entity');
			expect(result.suffixes).toContain('.service');
			expect(result.suffixes).toContain('.controller');
			expect(result.suffixes).toContain('.repository');
			expect(result.suffixes).toContain('.dto');
		});

		it('returns suffixes sorted by frequency', async () => {
			const testDir = join(TEST_ROOT, 'suffix-frequency');
			mkdirSync(testDir, { recursive: true });

			// Create multiple files with same suffix
			writeFileSync(join(testDir, 'user.service.ts'), '');
			writeFileSync(join(testDir, 'order.service.ts'), '');
			writeFileSync(join(testDir, 'product.service.ts'), '');
			writeFileSync(join(testDir, 'user.entity.ts'), '');

			const result = await detectNaming(testDir);

			// .service should appear before .entity (3 vs 1)
			const serviceIndex = result.suffixes.indexOf('.service');
			const entityIndex = result.suffixes.indexOf('.entity');

			expect(serviceIndex).toBeGreaterThanOrEqual(0);
			expect(entityIndex).toBeGreaterThanOrEqual(0);
			expect(serviceIndex).toBeLessThan(entityIndex);
		});
	});

	describe('file grouping detection', () => {
		it('detects separate file pattern', async () => {
			const testDir = join(TEST_ROOT, 'separate-files');
			mkdirSync(testDir, { recursive: true });

			// Create separate files with suffixes
			writeFileSync(join(testDir, 'user.entity.ts'), '');
			writeFileSync(join(testDir, 'user.repository.ts'), '');
			writeFileSync(join(testDir, 'user.service.ts'), '');

			const result = await detectNaming(testDir);

			expect(result.fileGrouping.detected).toBe('separate');
		});

		it('detects grouped pattern with barrel exports', async () => {
			const testDir = join(TEST_ROOT, 'grouped-files');
			mkdirSync(testDir, { recursive: true });
			mkdirSync(join(testDir, 'user'), { recursive: true });
			mkdirSync(join(testDir, 'order'), { recursive: true });

			// Create barrel export files
			writeFileSync(
				join(testDir, 'index.ts'),
				`export { UserEntity } from './user';\nexport { OrderEntity } from './order';`
			);
			writeFileSync(
				join(testDir, 'user', 'index.ts'),
				`export class UserEntity {}\nexport class UserRepository {}`
			);
			writeFileSync(
				join(testDir, 'order', 'index.ts'),
				`export class OrderEntity {}\nexport class OrderRepository {}`
			);

			const result = await detectNaming(testDir);

			expect(result.fileGrouping.detected).toBe('grouped');
		});

		it('identifies index.ts with single export as not barrel', async () => {
			const testDir = join(TEST_ROOT, 'single-export');
			mkdirSync(testDir, { recursive: true });

			// Create index.ts with only one export (not a barrel)
			writeFileSync(join(testDir, 'index.ts'), `export { User } from './user';`);
			writeFileSync(join(testDir, 'user.entity.ts'), '');
			writeFileSync(join(testDir, 'user.service.ts'), '');

			const result = await detectNaming(testDir);

			// Should detect as separate since index.ts is not a true barrel
			expect(result.fileGrouping.detected).toBe('separate');
		});
	});

	describe('edge cases', () => {
		it('handles empty directory', async () => {
			const testDir = join(TEST_ROOT, 'empty');
			mkdirSync(testDir, { recursive: true });

			const result = await detectNaming(testDir);

			expect(result.fileCase.detected).toBeDefined();
			expect(result.fileCase.confidence).toBe(0);
			expect(result.suffixes).toEqual([]);
			expect(result.fileGrouping.detected).toBeDefined();
		});

		it('handles mixed case styles', async () => {
			const testDir = join(TEST_ROOT, 'mixed-case');
			mkdirSync(testDir, { recursive: true });

			// Create mixed case files
			writeFileSync(join(testDir, 'user-service.ts'), '');
			writeFileSync(join(testDir, 'orderService.ts'), '');
			writeFileSync(join(testDir, 'ProductEntity.ts'), '');

			const result = await detectNaming(testDir);

			// Should detect the most common case
			expect(result.fileCase.detected).toBeDefined();
			expect(result.fileCase.confidence).toBeLessThan(100);
		});

		it('skips node_modules and dist directories', async () => {
			const testDir = join(TEST_ROOT, 'with-excluded');
			mkdirSync(join(testDir, 'node_modules'), { recursive: true });
			mkdirSync(join(testDir, 'dist'), { recursive: true });
			mkdirSync(join(testDir, 'src'), { recursive: true });

			// Create files in excluded dirs (should be ignored)
			writeFileSync(join(testDir, 'node_modules', 'package.ts'), '');
			writeFileSync(join(testDir, 'dist', 'build.ts'), '');
			// Create file in src (should be detected)
			writeFileSync(join(testDir, 'src', 'user-service.ts'), '');

			const result = await detectNaming(testDir);

			// Should only detect from src/user-service.ts
			expect(result.fileCase.detected).toBe('kebab-case');
			expect(result.fileCase.evidence).not.toContain(expect.stringContaining('node_modules'));
			expect(result.fileCase.evidence).not.toContain(expect.stringContaining('dist'));
		});
	});
});
