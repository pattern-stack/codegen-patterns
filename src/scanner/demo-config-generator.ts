#!/usr/bin/env bun

/**
 * Demo script showing the config generator in action.
 *
 * Run: bun tools/codegen/scanner/demo-config-generator.ts
 */

import { generateConfig } from './config-generator.js';
import type { ProjectProfile } from './types.js';

console.log('Config Generator Demo\n');
console.log('=' .repeat(60));

// Example 1: NestJS + Drizzle + Clean Architecture
console.log('\n1. NestJS + Drizzle + Clean Architecture');
console.log('-'.repeat(60));

const nestJsProfile: ProjectProfile = {
	framework: {
		detected: 'nestjs',
		confidence: 95,
		evidence: ['@nestjs/core in package.json', '@nestjs/common in package.json'],
	},
	orm: {
		detected: 'drizzle',
		confidence: 90,
		evidence: ['drizzle-orm in package.json'],
	},
	architecture: {
		detected: 'clean',
		confidence: 85,
		evidence: ['domain', 'application', 'infrastructure', 'presentation'],
	},
	naming: {
		fileCase: {
			detected: 'kebab-case',
			confidence: 95,
			evidence: ['user-service.ts', 'order-repository.ts'],
		},
		suffixes: ['.service', '.entity', '.repository', '.controller'],
		fileGrouping: {
			detected: 'separate',
			confidence: 88,
			evidence: ['user.entity.ts', 'user.service.ts'],
		},
	},
	paths: {
		root: '/app/backend',
		src: '/app/backend/src',
	},
};

const nestJsConfig = generateConfig(nestJsProfile);
console.log(JSON.stringify(nestJsConfig, null, 2));

// Example 2: Express + Prisma + Feature-based
console.log('\n\n2. Express + Prisma + Feature-based');
console.log('-'.repeat(60));

const expressProfile: ProjectProfile = {
	framework: {
		detected: 'express',
		confidence: 88,
		evidence: ['express in package.json'],
	},
	orm: {
		detected: 'prisma',
		confidence: 92,
		evidence: ['@prisma/client in package.json', 'prisma/schema.prisma'],
	},
	architecture: {
		detected: 'feature',
		confidence: 80,
		evidence: ['features', 'features/users', 'features/auth'],
	},
	naming: {
		fileCase: {
			detected: 'camelCase',
			confidence: 85,
			evidence: ['userService.ts', 'authController.ts'],
		},
		suffixes: ['.service', '.controller'],
		fileGrouping: {
			detected: 'separate',
			confidence: 80,
			evidence: ['userService.ts', 'userController.ts'],
		},
	},
	paths: {
		root: '/project',
		src: '/project/src',
	},
};

const expressConfig = generateConfig(expressProfile);
console.log(JSON.stringify(expressConfig, null, 2));

// Example 3: Plain TypeScript + No ORM + Flat
console.log('\n\n3. Plain TypeScript + No ORM + Flat Structure');
console.log('-'.repeat(60));

const plainProfile: ProjectProfile = {
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
	architecture: {
		detected: 'flat',
		confidence: 100,
		evidence: ['No architectural pattern detected'],
	},
	naming: {
		fileCase: {
			detected: 'PascalCase',
			confidence: 70,
			evidence: ['UserService.ts', 'OrderRepository.ts'],
		},
		suffixes: [],
		fileGrouping: {
			detected: 'grouped',
			confidence: 60,
			evidence: ['index.ts with barrel exports'],
		},
	},
	paths: {
		root: '/lib',
		src: null, // No src directory
	},
};

const plainConfig = generateConfig(plainProfile);
console.log(JSON.stringify(plainConfig, null, 2));

// Example 4: YAML-ready output
console.log('\n\n4. YAML-ready Configuration (NestJS example)');
console.log('-'.repeat(60));
console.log(`# codegen.config.yaml
framework: ${nestJsConfig.framework}
orm: ${nestJsConfig.orm}
folder_structure: ${nestJsConfig.folder_structure}
file_grouping: ${nestJsConfig.file_grouping}

naming:
  fileCase: ${nestJsConfig.naming.fileCase}
  suffixes:${nestJsConfig.naming.suffixes.map(s => `\n    - ${s}`).join('')}

paths:
  backend_src: ${nestJsConfig.paths.backend_src}
  domain: ${nestJsConfig.paths.domain}
  application: ${nestJsConfig.paths.application}
  infrastructure: ${nestJsConfig.paths.infrastructure}
  presentation: ${nestJsConfig.paths.presentation}

# Confidence scores (for review)
# Overall: ${nestJsConfig.confidence.overall}%
# Framework: ${nestJsConfig.confidence.framework}%
# ORM: ${nestJsConfig.confidence.orm}%
# Architecture: ${nestJsConfig.confidence.architecture}%
# Naming: ${nestJsConfig.confidence.naming}%
`);

console.log('\n' + '='.repeat(60));
console.log('Demo completed successfully!');
