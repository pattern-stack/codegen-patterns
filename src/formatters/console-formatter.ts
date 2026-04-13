/**
 * Console Formatter
 *
 * Pretty terminal output with colors for the domain analysis results.
 */

import type { AnalysisResult, AnalysisIssue, Severity } from '../analyzer/types';

// ANSI color codes
const colors = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',

	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	white: '\x1b[37m',

	bgRed: '\x1b[41m',
	bgGreen: '\x1b[42m',
	bgYellow: '\x1b[43m',
};

function color(text: string, ...styles: string[]): string {
	return `${styles.join('')}${text}${colors.reset}`;
}

function severityColor(severity: Severity): string {
	switch (severity) {
		case 'error':
			return colors.red;
		case 'warning':
			return colors.yellow;
		case 'info':
			return colors.cyan;
	}
}

function severityIcon(severity: Severity): string {
	switch (severity) {
		case 'error':
			return 'X';
		case 'warning':
			return '!';
		case 'info':
			return 'i';
	}
}

/**
 * Format analysis result for console output
 */
export function formatConsole(result: AnalysisResult): string {
	const lines: string[] = [];

	// Header
	lines.push('');
	lines.push(color('='.repeat(60), colors.dim));
	lines.push(color('  Domain Analysis Report', colors.bold, colors.cyan));
	lines.push(color('='.repeat(60), colors.dim));
	lines.push('');

	// Statistics
	lines.push(...formatStatistics(result));

	// Entity summary
	lines.push(...formatEntities(result));

	// Relationships
	lines.push(...formatRelationships(result));

	// Issues
	if (result.issues.length > 0) {
		lines.push(...formatIssues(result.issues));
	}

	// Final status
	lines.push('');
	lines.push(color('-'.repeat(60), colors.dim));

	const errors = result.issues.filter((i) => i.severity === 'error');
	const warnings = result.issues.filter((i) => i.severity === 'warning');
	const infos = result.issues.filter((i) => i.severity === 'info');

	if (result.isValid) {
		lines.push(
			color(
				`[OK] Domain is valid (${warnings.length} warnings, ${infos.length} info)`,
				colors.green
			)
		);
	} else {
		lines.push(color(`[FAIL] Domain has ${errors.length} errors`, colors.red));
	}

	lines.push(color('-'.repeat(60), colors.dim));
	lines.push('');

	return lines.join('\n');
}

function formatStatistics(result: AnalysisResult): string[] {
	const lines: string[] = [];
	const stats = result.statistics;

	lines.push(color('Statistics:', colors.bold));
	lines.push('');
	lines.push(`   Entities:        ${stats.totalEntities}`);
	lines.push(
		`   Fields:          ${stats.totalFields} (avg ${stats.averageFieldsPerEntity.toFixed(1)}/entity)`
	);
	lines.push(`   Relationships:   ${stats.totalRelationships}`);
	lines.push(`   With behaviors:  ${stats.entitiesWithBehaviors}`);
	lines.push('');

	// Field types breakdown
	lines.push('   Field types:');
	const sortedTypes = Object.entries(stats.fieldsByType).sort((a, b) => b[1] - a[1]);
	for (const [type, count] of sortedTypes) {
		const bar = color('|'.repeat(Math.min(count, 20)), colors.blue);
		lines.push(`     ${type.padEnd(12)} ${bar} ${count}`);
	}
	lines.push('');

	// Relationship types breakdown
	if (stats.totalRelationships > 0) {
		lines.push('   Relationship types:');
		const sortedRels = Object.entries(stats.relationshipsByType).sort((a, b) => b[1] - a[1]);
		for (const [type, count] of sortedRels) {
			const bar = color('|'.repeat(Math.min(count, 20)), colors.magenta);
			lines.push(`     ${type.padEnd(12)} ${bar} ${count}`);
		}
		lines.push('');
	}

	return lines;
}

function formatEntities(result: AnalysisResult): string[] {
	const lines: string[] = [];

	lines.push(color('Entities:', colors.bold));
	lines.push('');

	for (const entity of result.entities) {
		const fieldCount = entity.fields.size;
		const relCount = entity.relationships.size;
		lines.push(
			`   ${color(entity.name, colors.cyan)} (${fieldCount} fields, ${relCount} relationships)`
		);
		if (entity.behaviors.length > 0) {
			lines.push(color(`      behaviors: ${entity.behaviors.join(', ')}`, colors.dim));
		}
	}
	lines.push('');

	return lines;
}

function formatRelationships(result: AnalysisResult): string[] {
	const lines: string[] = [];

	if (result.graph.edges.length === 0) {
		return lines;
	}

	lines.push(color('Relationships:', colors.bold));
	lines.push('');

	for (const edge of result.graph.edges) {
		const arrow = getCardinalityArrow(edge.cardinality);
		const bidir = edge.bidirectional ? color(' (bidirectional)', colors.dim) : '';
		lines.push(
			`   ${edge.from.padEnd(20)} ${arrow} ${edge.to} ${color(`(${edge.relationship.type})`, colors.dim)}${bidir}`
		);
	}
	lines.push('');

	return lines;
}

function getCardinalityArrow(cardinality: string): string {
	switch (cardinality) {
		case '1:N':
			return color('--<', colors.magenta);
		case 'N:1':
			return color('>--', colors.magenta);
		case '1:1':
			return color('---', colors.magenta);
		case 'N:M':
			return color('>-<', colors.magenta);
		default:
			return color('-->', colors.magenta);
	}
}

function formatIssues(issues: AnalysisIssue[]): string[] {
	const lines: string[] = [];

	// Group by severity
	const errors = issues.filter((i) => i.severity === 'error');
	const warnings = issues.filter((i) => i.severity === 'warning');
	const infos = issues.filter((i) => i.severity === 'info');

	if (errors.length > 0) {
		lines.push(color(`Errors (${errors.length}):`, colors.bold, colors.red));
		lines.push('');
		lines.push(...formatIssueList(errors, 'error'));
		lines.push('');
	}

	if (warnings.length > 0) {
		lines.push(color(`Warnings (${warnings.length}):`, colors.bold, colors.yellow));
		lines.push('');
		lines.push(...formatIssueList(warnings, 'warning'));
		lines.push('');
	}

	if (infos.length > 0) {
		lines.push(color(`Info (${infos.length}):`, colors.bold, colors.cyan));
		lines.push('');
		lines.push(...formatIssueList(infos, 'info', 5)); // Only show first 5 info messages
		lines.push('');
	}

	return lines;
}

function formatIssueList(
	issues: AnalysisIssue[],
	severity: Severity,
	limit?: number
): string[] {
	const lines: string[] = [];
	const displayIssues = limit ? issues.slice(0, limit) : issues;

	// Group by type
	const byType = new Map<string, AnalysisIssue[]>();
	for (const issue of displayIssues) {
		const list = byType.get(issue.type) ?? [];
		list.push(issue);
		byType.set(issue.type, list);
	}

	for (const [type, typeIssues] of byType) {
		lines.push(color(`   ${type} (${typeIssues.length}):`, colors.dim));

		for (const issue of typeIssues.slice(0, 5)) {
			const location = issue.entity
				? `${issue.entity}${issue.field ? '.' + issue.field : ''}`
				: issue.path ?? 'unknown';

			const icon = color(`[${severityIcon(severity)}]`, severityColor(severity));
			lines.push(`     ${icon} ${color(location, colors.bold)}: ${issue.message}`);

			if (issue.suggestion) {
				lines.push(color(`        -> ${issue.suggestion}`, colors.dim));
			}
		}

		if (typeIssues.length > 5) {
			lines.push(color(`     ... and ${typeIssues.length - 5} more`, colors.dim));
		}
	}

	if (limit && issues.length > limit) {
		lines.push(color(`   ... and ${issues.length - limit} more info messages`, colors.dim));
	}

	return lines;
}
