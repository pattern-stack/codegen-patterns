import { describe, it, expect } from 'bun:test';
import { generateConfig, type ProposedConfig } from './config-generator.js';
import type { ProjectProfile } from './types.js';

/**
 * Helper to create a minimal ProjectProfile for testing
 */
function createMockProfile(
	overrides: Partial<ProjectProfile> = {}
): ProjectProfile {
	const defaults: ProjectProfile = {
		framework: {
			detected: 'nestjs',
			confidence: 85,
			evidence: ['@nestjs/core in package.json'],
		},
		orm: {
			detected: 'drizzle',
			confidence: 90,
			evidence: ['drizzle-orm in package.json'],
		},
		architecture: {
			detected: 'clean',
			confidence: 80,
			evidence: ['domain', 'application', 'infrastructure', 'presentation'],
		},
		naming: {
			fileCase: {
				detected: 'kebab-case',
				confidence: 95,
				evidence: ['user-service.ts', 'order-repository.ts'],
			},
			suffixes: ['.service', '.entity', '.repository'],
			fileGrouping: {
				detected: 'separate',
				confidence: 85,
				evidence: ['user.entity.ts', 'user.service.ts'],
			},
		},
		paths: {
			root: '/test/project',
			src: '/test/project/src',
		},
	};

	return { ...defaults, ...overrides };
}

describe('generateConfig', () => {
	describe('core settings', () => {
		it('passes through framework and ORM from detection', () => {
			const profile = createMockProfile({
				framework: {
					detected: 'fastify',
					confidence: 90,
					evidence: ['fastify in package.json'],
				},
				orm: {
					detected: 'prisma',
					confidence: 85,
					evidence: ['@prisma/client in package.json'],
				},
			});

			const config = generateConfig(profile);

			expect(config.framework).toBe('fastify');
			expect(config.orm).toBe('prisma');
		});

		it('handles plain framework with no ORM', () => {
			const profile = createMockProfile({
				framework: {
					detected: 'plain',
					confidence: 50,
					evidence: ['No framework detected'],
				},
				orm: {
					detected: 'none',
					confidence: 100,
					evidence: ['No ORM dependencies found'],
				},
			});

			const config = generateConfig(profile);

			expect(config.framework).toBe('plain');
			expect(config.orm).toBe('none');
		});
	});

	describe('folder structure', () => {
		it('uses nested structure for clean architecture', () => {
			const profile = createMockProfile({
				architecture: {
					detected: 'clean',
					confidence: 85,
					evidence: ['domain', 'application', 'infrastructure'],
				},
			});

			const config = generateConfig(profile);

			expect(config.folder_structure).toBe('nested');
		});

		it('uses nested structure for feature architecture', () => {
			const profile = createMockProfile({
				architecture: {
					detected: 'feature',
					confidence: 80,
					evidence: ['features', 'features/auth', 'features/users'],
				},
			});

			const config = generateConfig(profile);

			expect(config.folder_structure).toBe('nested');
		});

		it('uses flat structure for MVC architecture', () => {
			const profile = createMockProfile({
				architecture: {
					detected: 'mvc',
					confidence: 90,
					evidence: ['models', 'views', 'controllers'],
				},
			});

			const config = generateConfig(profile);

			expect(config.folder_structure).toBe('flat');
		});

		it('uses flat structure for flat architecture', () => {
			const profile = createMockProfile({
				architecture: {
					detected: 'flat',
					confidence: 100,
					evidence: ['No architectural pattern detected'],
				},
			});

			const config = generateConfig(profile);

			expect(config.folder_structure).toBe('flat');
		});
	});

	describe('file grouping', () => {
		it('uses separate grouping when detected', () => {
			const profile = createMockProfile({
				naming: {
					fileCase: { detected: 'kebab-case', confidence: 95, evidence: [] },
					suffixes: ['.service', '.entity'],
					fileGrouping: {
						detected: 'separate',
						confidence: 90,
						evidence: ['user.entity.ts', 'user.service.ts'],
					},
				},
			});

			const config = generateConfig(profile);

			expect(config.file_grouping).toBe('separate');
		});

		it('uses grouped grouping when detected', () => {
			const profile = createMockProfile({
				naming: {
					fileCase: { detected: 'kebab-case', confidence: 95, evidence: [] },
					suffixes: [],
					fileGrouping: {
						detected: 'grouped',
						confidence: 85,
						evidence: ['index.ts with barrel exports'],
					},
				},
			});

			const config = generateConfig(profile);

			expect(config.file_grouping).toBe('grouped');
		});
	});

	describe('naming conventions', () => {
		it('includes file case and suffixes', () => {
			const profile = createMockProfile({
				naming: {
					fileCase: {
						detected: 'PascalCase',
						confidence: 92,
						evidence: ['UserService.ts', 'OrderRepository.ts'],
					},
					suffixes: ['.service', '.repository', '.controller'],
					fileGrouping: { detected: 'separate', confidence: 80, evidence: [] },
				},
			});

			const config = generateConfig(profile);

			expect(config.naming.fileCase).toBe('PascalCase');
			expect(config.naming.suffixes).toEqual(['.service', '.repository', '.controller']);
		});

		it('handles empty suffixes list', () => {
			const profile = createMockProfile({
				naming: {
					fileCase: { detected: 'camelCase', confidence: 88, evidence: [] },
					suffixes: [],
					fileGrouping: { detected: 'grouped', confidence: 75, evidence: [] },
				},
			});

			const config = generateConfig(profile);

			expect(config.naming.suffixes).toEqual([]);
		});
	});

	describe('paths inference', () => {
		describe('clean architecture', () => {
			it('maps standard clean architecture paths', () => {
				const profile = createMockProfile({
					architecture: {
						detected: 'clean',
						confidence: 85,
						evidence: ['domain', 'application', 'infrastructure', 'presentation'],
					},
					paths: {
						root: '/project',
						src: '/project/src',
					},
				});

				const config = generateConfig(profile);

				expect(config.paths.backend_src).toBe('/project/src');
				expect(config.paths.domain).toBe('/project/src/domain');
				expect(config.paths.application).toBe('/project/src/application');
				expect(config.paths.infrastructure).toBe('/project/src/infrastructure');
				expect(config.paths.presentation).toBe('/project/src/presentation');
			});

			it('handles applications plural variant', () => {
				const profile = createMockProfile({
					architecture: {
						detected: 'clean',
						confidence: 80,
						evidence: ['domain', 'applications', 'infrastructure'],
					},
					paths: {
						root: '/project',
						src: '/project/src',
					},
				});

				const config = generateConfig(profile);

				expect(config.paths.application).toBe('/project/src/applications');
			});

			it('handles use-cases variant for application layer', () => {
				const profile = createMockProfile({
					architecture: {
						detected: 'clean',
						confidence: 75,
						evidence: ['domain', 'use-cases', 'infrastructure'],
					},
					paths: {
						root: '/project',
						src: '/project/src',
					},
				});

				const config = generateConfig(profile);

				expect(config.paths.application).toBe('/project/src/use-cases');
			});
		});

		describe('feature architecture', () => {
			it('uses features/ as base path', () => {
				const profile = createMockProfile({
					architecture: {
						detected: 'feature',
						confidence: 85,
						evidence: ['features', 'features/auth', 'features/users'],
					},
					paths: {
						root: '/project',
						src: '/project/src',
					},
				});

				const config = generateConfig(profile);

				expect(config.paths.backend_src).toBe('/project/src');
				expect(config.paths.domain).toBe('/project/src/features/{feature}/domain');
				expect(config.paths.application).toBe('/project/src/features/{feature}/application');
				expect(config.paths.infrastructure).toBe('/project/src/features/{feature}/infrastructure');
				expect(config.paths.presentation).toBe('/project/src/features/{feature}/presentation');
			});

			it('uses modules/ as base path when detected', () => {
				const profile = createMockProfile({
					architecture: {
						detected: 'feature',
						confidence: 80,
						evidence: ['modules', 'modules/auth', 'modules/users'],
					},
					paths: {
						root: '/project',
						src: '/project/src',
					},
				});

				const config = generateConfig(profile);

				expect(config.paths.domain).toBe('/project/src/modules/{feature}/domain');
			});
		});

		describe('MVC architecture', () => {
			it('maps MVC paths correctly', () => {
				const profile = createMockProfile({
					architecture: {
						detected: 'mvc',
						confidence: 90,
						evidence: ['models', 'controllers', 'views'],
					},
					paths: {
						root: '/project',
						src: '/project/src',
					},
				});

				const config = generateConfig(profile);

				expect(config.paths.backend_src).toBe('/project/src');
				expect(config.paths.domain).toBe('/project/src/models');
				expect(config.paths.application).toBe('/project/src/services');
				expect(config.paths.infrastructure).toBe('/project/src/lib');
				expect(config.paths.presentation).toBe('/project/src/controllers');
			});
		});

		describe('flat architecture', () => {
			it('uses src/ for all paths', () => {
				const profile = createMockProfile({
					architecture: {
						detected: 'flat',
						confidence: 100,
						evidence: ['No architectural pattern detected'],
					},
					paths: {
						root: '/project',
						src: '/project/src',
					},
				});

				const config = generateConfig(profile);

				expect(config.paths.backend_src).toBe('/project/src');
				expect(config.paths.domain).toBe('/project/src');
				expect(config.paths.application).toBe('/project/src');
				expect(config.paths.infrastructure).toBe('/project/src');
				expect(config.paths.presentation).toBe('/project/src');
			});
		});

		describe('edge cases', () => {
			it('handles project without src/ directory', () => {
				const profile = createMockProfile({
					paths: {
						root: '/project',
						src: null,
					},
				});

				const config = generateConfig(profile);

				expect(config.paths.backend_src).toBe('/project');
				expect(config.paths.domain).toBe('/project/domain');
			});

			it('uses fallback paths when evidence is minimal', () => {
				const profile = createMockProfile({
					architecture: {
						detected: 'clean',
						confidence: 50,
						evidence: ['infrastructure'], // Only one folder found
					},
					paths: {
						root: '/project',
						src: '/project/src',
					},
				});

				const config = generateConfig(profile);

				// Should still provide valid paths with defaults
				expect(config.paths.domain).toBe('/project/src/domain');
				expect(config.paths.application).toBe('/project/src/application');
			});
		});
	});

	describe('confidence calculation', () => {
		it('calculates overall confidence as average of all detections', () => {
			const profile = createMockProfile({
				framework: { detected: 'nestjs', confidence: 80, evidence: [] },
				orm: { detected: 'drizzle', confidence: 90, evidence: [] },
				architecture: { detected: 'clean', confidence: 70, evidence: [] },
				naming: {
					fileCase: { detected: 'kebab-case', confidence: 95, evidence: [] },
					suffixes: [],
					fileGrouping: { detected: 'separate', confidence: 85, evidence: [] },
				},
			});

			const config = generateConfig(profile);

			// Naming: (95 + 85) / 2 = 90
			// Overall: (80 + 90 + 70 + 90) / 4 = 82.5 -> 82 (rounded)
			expect(config.confidence.framework).toBe(80);
			expect(config.confidence.orm).toBe(90);
			expect(config.confidence.architecture).toBe(70);
			expect(config.confidence.naming).toBe(90);
			expect(config.confidence.overall).toBe(83); // Rounded from 82.5
		});

		it('handles low confidence detections', () => {
			const profile = createMockProfile({
				framework: { detected: 'plain', confidence: 30, evidence: [] },
				orm: { detected: 'none', confidence: 50, evidence: [] },
				architecture: { detected: 'flat', confidence: 40, evidence: [] },
				naming: {
					fileCase: { detected: 'kebab-case', confidence: 60, evidence: [] },
					suffixes: [],
					fileGrouping: { detected: 'separate', confidence: 50, evidence: [] },
				},
			});

			const config = generateConfig(profile);

			// All confidences should be preserved
			expect(config.confidence.overall).toBeLessThan(60);
			expect(config.confidence.framework).toBe(30);
			expect(config.confidence.orm).toBe(50);
		});

		it('handles perfect confidence detections', () => {
			const profile = createMockProfile({
				framework: { detected: 'nestjs', confidence: 100, evidence: [] },
				orm: { detected: 'drizzle', confidence: 100, evidence: [] },
				architecture: { detected: 'clean', confidence: 100, evidence: [] },
				naming: {
					fileCase: { detected: 'kebab-case', confidence: 100, evidence: [] },
					suffixes: [],
					fileGrouping: { detected: 'separate', confidence: 100, evidence: [] },
				},
			});

			const config = generateConfig(profile);

			expect(config.confidence.overall).toBe(100);
			expect(config.confidence.framework).toBe(100);
			expect(config.confidence.orm).toBe(100);
			expect(config.confidence.architecture).toBe(100);
			expect(config.confidence.naming).toBe(100);
		});
	});

	describe('integration scenarios', () => {
		it('generates valid config for NestJS + Drizzle + Clean Architecture', () => {
			const profile = createMockProfile({
				framework: { detected: 'nestjs', confidence: 95, evidence: [] },
				orm: { detected: 'drizzle', confidence: 90, evidence: [] },
				architecture: {
					detected: 'clean',
					confidence: 85,
					evidence: ['domain', 'application', 'infrastructure', 'presentation'],
				},
				naming: {
					fileCase: { detected: 'kebab-case', confidence: 92, evidence: [] },
					suffixes: ['.entity', '.service', '.repository', '.controller'],
					fileGrouping: { detected: 'separate', confidence: 88, evidence: [] },
				},
				paths: { root: '/app', src: '/app/src' },
			});

			const config = generateConfig(profile);

			expect(config.framework).toBe('nestjs');
			expect(config.orm).toBe('drizzle');
			expect(config.folder_structure).toBe('nested');
			expect(config.file_grouping).toBe('separate');
			expect(config.naming.fileCase).toBe('kebab-case');
			expect(config.paths.backend_src).toBe('/app/src');
			expect(config.confidence.overall).toBeGreaterThan(85);
		});

		it('generates valid config for Express + TypeORM + MVC', () => {
			const profile = createMockProfile({
				framework: { detected: 'express', confidence: 88, evidence: [] },
				orm: { detected: 'typeorm', confidence: 85, evidence: [] },
				architecture: {
					detected: 'mvc',
					confidence: 90,
					evidence: ['models', 'controllers', 'views'],
				},
				naming: {
					fileCase: { detected: 'PascalCase', confidence: 80, evidence: [] },
					suffixes: [],
					fileGrouping: { detected: 'grouped', confidence: 75, evidence: [] },
				},
				paths: { root: '/project', src: '/project/src' },
			});

			const config = generateConfig(profile);

			expect(config.framework).toBe('express');
			expect(config.orm).toBe('typeorm');
			expect(config.folder_structure).toBe('flat');
			expect(config.file_grouping).toBe('grouped');
			expect(config.naming.fileCase).toBe('PascalCase');
			expect(config.paths.domain).toBe('/project/src/models');
		});

		it('generates valid config for Fastify + Prisma + Feature-based', () => {
			const profile = createMockProfile({
				framework: { detected: 'fastify', confidence: 92, evidence: [] },
				orm: { detected: 'prisma', confidence: 95, evidence: [] },
				architecture: {
					detected: 'feature',
					confidence: 87,
					evidence: ['modules', 'modules/users', 'modules/auth'],
				},
				naming: {
					fileCase: { detected: 'camelCase', confidence: 85, evidence: [] },
					suffixes: ['.service', '.controller'],
					fileGrouping: { detected: 'separate', confidence: 80, evidence: [] },
				},
				paths: { root: '/app', src: '/app/src' },
			});

			const config = generateConfig(profile);

			expect(config.framework).toBe('fastify');
			expect(config.orm).toBe('prisma');
			expect(config.folder_structure).toBe('nested');
			expect(config.file_grouping).toBe('separate');
			expect(config.naming.fileCase).toBe('camelCase');
			expect(config.paths.domain).toContain('modules/{feature}');
		});
	});
});
