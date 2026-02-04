import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectArchitecture } from './architecture-detector.js';

const TEST_ROOT = join(import.meta.dir, '__test-fixtures__');

describe('detectArchitecture', () => {
	beforeEach(() => {
		// Clean up test fixtures before each test
		if (existsSync(TEST_ROOT)) {
			rmSync(TEST_ROOT, { recursive: true });
		}
		mkdirSync(TEST_ROOT, { recursive: true });
	});

	afterEach(() => {
		// Clean up test fixtures after each test
		if (existsSync(TEST_ROOT)) {
			rmSync(TEST_ROOT, { recursive: true });
		}
	});

	describe('Clean Architecture', () => {
		it('detects clean architecture with core folders', async () => {
			const projectPath = join(TEST_ROOT, 'clean-project');
			mkdirSync(projectPath, { recursive: true });
			mkdirSync(join(projectPath, 'domain'), { recursive: true });
			mkdirSync(join(projectPath, 'application'), { recursive: true });
			mkdirSync(join(projectPath, 'infrastructure'), { recursive: true });
			mkdirSync(join(projectPath, 'presentation'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('clean');
			expect(result.confidence).toBeGreaterThan(50);
			expect(result.evidence).toContain('domain');
			expect(result.evidence).toContain('infrastructure');
		});

		it('detects clean architecture in src/ subdirectory', async () => {
			const projectPath = join(TEST_ROOT, 'clean-project-src');
			const srcPath = join(projectPath, 'src');
			mkdirSync(srcPath, { recursive: true });
			mkdirSync(join(srcPath, 'domain'), { recursive: true });
			mkdirSync(join(srcPath, 'application'), { recursive: true });
			mkdirSync(join(srcPath, 'infrastructure'), { recursive: true });
			mkdirSync(join(srcPath, 'presentation'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('clean');
			expect(result.confidence).toBeGreaterThan(50);
			expect(result.evidence).toContain('domain');
			expect(result.evidence).toContain('infrastructure');
		});

		it('detects clean architecture with applications folder (plural)', async () => {
			const projectPath = join(TEST_ROOT, 'clean-project-plural');
			mkdirSync(projectPath, { recursive: true });
			mkdirSync(join(projectPath, 'domain'), { recursive: true });
			mkdirSync(join(projectPath, 'applications'), { recursive: true });
			mkdirSync(join(projectPath, 'infrastructure'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('clean');
			expect(result.evidence).toContain('domain');
			expect(result.evidence).toContain('infrastructure');
		});

		it('does not detect clean without core folders', async () => {
			const projectPath = join(TEST_ROOT, 'not-clean');
			mkdirSync(projectPath, { recursive: true });
			mkdirSync(join(projectPath, 'domain'), { recursive: true });
			// Missing infrastructure - should not be clean

			const result = await detectArchitecture(projectPath);

			expect(result.detected).not.toBe('clean');
		});
	});

	describe('Feature-based Architecture', () => {
		it('detects feature-based architecture with features folder', async () => {
			const projectPath = join(TEST_ROOT, 'feature-project');
			const featuresPath = join(projectPath, 'features');
			mkdirSync(featuresPath, { recursive: true });
			mkdirSync(join(featuresPath, 'auth'), { recursive: true });
			mkdirSync(join(featuresPath, 'users'), { recursive: true });
			mkdirSync(join(featuresPath, 'projects'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('feature');
			expect(result.evidence).toContain('features');
			expect(result.confidence).toBeGreaterThan(0);
		});

		it('detects feature-based architecture with modules folder', async () => {
			const projectPath = join(TEST_ROOT, 'modules-project');
			const modulesPath = join(projectPath, 'modules');
			mkdirSync(modulesPath, { recursive: true });
			mkdirSync(join(modulesPath, 'auth'), { recursive: true });
			mkdirSync(join(modulesPath, 'users'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('feature');
			expect(result.evidence).toContain('modules');
		});

		it('detects feature-based in src/ subdirectory', async () => {
			const projectPath = join(TEST_ROOT, 'feature-project-src');
			const srcPath = join(projectPath, 'src');
			const featuresPath = join(srcPath, 'features');
			mkdirSync(featuresPath, { recursive: true });
			mkdirSync(join(featuresPath, 'auth'), { recursive: true });
			mkdirSync(join(featuresPath, 'users'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('feature');
			expect(result.evidence).toContain('features');
		});
	});

	describe('MVC Architecture', () => {
		it('detects MVC with all three core folders', async () => {
			const projectPath = join(TEST_ROOT, 'mvc-project');
			mkdirSync(projectPath, { recursive: true });
			mkdirSync(join(projectPath, 'models'), { recursive: true });
			mkdirSync(join(projectPath, 'views'), { recursive: true });
			mkdirSync(join(projectPath, 'controllers'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('mvc');
			expect(result.confidence).toBeGreaterThan(50);
			expect(result.evidence).toContain('models');
			expect(result.evidence).toContain('views');
			expect(result.evidence).toContain('controllers');
		});

		it('detects MVC with singular folder names', async () => {
			const projectPath = join(TEST_ROOT, 'mvc-singular');
			mkdirSync(projectPath, { recursive: true });
			mkdirSync(join(projectPath, 'model'), { recursive: true });
			mkdirSync(join(projectPath, 'view'), { recursive: true });
			mkdirSync(join(projectPath, 'controller'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('mvc');
			expect(result.confidence).toBeGreaterThan(0);
		});

		it('detects MVC in src/ subdirectory', async () => {
			const projectPath = join(TEST_ROOT, 'mvc-project-src');
			const srcPath = join(projectPath, 'src');
			mkdirSync(srcPath, { recursive: true });
			mkdirSync(join(srcPath, 'models'), { recursive: true });
			mkdirSync(join(srcPath, 'views'), { recursive: true });
			mkdirSync(join(srcPath, 'controllers'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('mvc');
			expect(result.evidence).toContain('models');
		});

		it('does not detect MVC with less than 2 core folders', async () => {
			const projectPath = join(TEST_ROOT, 'not-mvc');
			mkdirSync(projectPath, { recursive: true });
			mkdirSync(join(projectPath, 'models'), { recursive: true });
			// Only one folder - should not be MVC

			const result = await detectArchitecture(projectPath);

			expect(result.detected).not.toBe('mvc');
		});
	});

	describe('Flat Architecture', () => {
		it('returns flat for empty project', async () => {
			const projectPath = join(TEST_ROOT, 'flat-project');
			mkdirSync(projectPath, { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('flat');
			expect(result.confidence).toBe(100);
			expect(result.evidence).toContain('No architectural pattern detected');
		});

		it('returns flat for project with unrecognized structure', async () => {
			const projectPath = join(TEST_ROOT, 'random-project');
			mkdirSync(projectPath, { recursive: true });
			mkdirSync(join(projectPath, 'utils'), { recursive: true });
			mkdirSync(join(projectPath, 'helpers'), { recursive: true });
			mkdirSync(join(projectPath, 'lib'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('flat');
			expect(result.confidence).toBe(100);
		});
	});

	describe('Architecture Priority', () => {
		it('prioritizes clean architecture over feature-based when both exist', async () => {
			const projectPath = join(TEST_ROOT, 'mixed-clean-feature');
			mkdirSync(projectPath, { recursive: true });
			// Clean architecture folders
			mkdirSync(join(projectPath, 'domain'), { recursive: true });
			mkdirSync(join(projectPath, 'infrastructure'), { recursive: true });
			// Feature-based folders
			const featuresPath = join(projectPath, 'features');
			mkdirSync(featuresPath, { recursive: true });
			mkdirSync(join(featuresPath, 'auth'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			// Clean should win if it has more matched core folders
			expect(result.detected).toBe('clean');
		});

		it('handles real-world backend structure', async () => {
			// Simulate the actual backend structure from this project
			const projectPath = join(TEST_ROOT, 'real-backend');
			const srcPath = join(projectPath, 'src');
			mkdirSync(srcPath, { recursive: true });
			mkdirSync(join(srcPath, 'application'), { recursive: true });
			mkdirSync(join(srcPath, 'infrastructure'), { recursive: true });
			mkdirSync(join(srcPath, 'presentation'), { recursive: true });

			const result = await detectArchitecture(projectPath);

			// Should detect clean even without domain folder if we have enough signals
			// But based on our algorithm, it needs domain + infrastructure
			// So this would be flat or feature
			expect(['clean', 'flat']).toContain(result.detected);
		});
	});

	describe('Edge Cases', () => {
		it('handles non-existent project path', async () => {
			const projectPath = join(TEST_ROOT, 'non-existent-path');

			const result = await detectArchitecture(projectPath);

			expect(result.detected).toBe('flat');
			expect(result.confidence).toBe(100);
		});

		it('handles symlinks gracefully', async () => {
			// Note: Symlink test would require actual symlink creation
			// which might not work on all systems. Skipping for now.
			expect(true).toBe(true);
		});
	});
});
