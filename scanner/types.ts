export interface DetectionResult<T> {
	detected: T;
	confidence: number; // 0-100
	evidence: string[]; // Files/patterns that led to detection
}

export interface ProjectProfile {
	framework: DetectionResult<'nestjs' | 'fastify' | 'express' | 'plain'>;
	orm: DetectionResult<'drizzle' | 'prisma' | 'typeorm' | 'none'>;
	architecture: DetectionResult<'clean' | 'feature' | 'mvc' | 'flat'>;
	naming: {
		fileCase: DetectionResult<'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case'>;
		suffixes: string[]; // detected suffixes like .entity.ts, .service.ts
		fileGrouping: DetectionResult<'separate' | 'grouped'>;
	};
	paths: {
		root: string;
		src: string | null;
	};
}

export interface ScanOptions {
	directory: string;
	verbose?: boolean;
}
