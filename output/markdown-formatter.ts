/**
 * Markdown Formatter
 *
 * Documentation output with Mermaid diagrams for the domain analysis results.
 */

import type { AnalysisResult, ParsedEntity, RelationshipEdge } from '../analyzer/types';

/**
 * Format analysis result as Markdown documentation
 */
export function formatMarkdown(result: AnalysisResult): string {
	const lines: string[] = [];

	// Title
	lines.push('# Domain Model Documentation');
	lines.push('');
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push('');

	// Overview statistics
	lines.push('## Overview');
	lines.push('');
	lines.push('| Metric | Value |');
	lines.push('|--------|-------|');
	lines.push(`| Entities | ${result.statistics.totalEntities} |`);
	lines.push(`| Total Fields | ${result.statistics.totalFields} |`);
	lines.push(`| Total Relationships | ${result.statistics.totalRelationships} |`);
	lines.push(
		`| Avg Fields/Entity | ${result.statistics.averageFieldsPerEntity.toFixed(1)} |`
	);
	lines.push('');

	// Field type distribution
	lines.push('### Field Type Distribution');
	lines.push('');
	lines.push('| Type | Count |');
	lines.push('|------|-------|');
	const sortedTypes = Object.entries(result.statistics.fieldsByType).sort(
		(a, b) => b[1] - a[1]
	);
	for (const [type, count] of sortedTypes) {
		lines.push(`| ${type} | ${count} |`);
	}
	lines.push('');

	// Relationship type distribution
	if (result.statistics.totalRelationships > 0) {
		lines.push('### Relationship Type Distribution');
		lines.push('');
		lines.push('| Type | Count |');
		lines.push('|------|-------|');
		const sortedRels = Object.entries(result.statistics.relationshipsByType).sort(
			(a, b) => b[1] - a[1]
		);
		for (const [type, count] of sortedRels) {
			lines.push(`| ${type} | ${count} |`);
		}
		lines.push('');
	}

	// Entity Relationship Diagram
	lines.push('## Entity Relationship Diagram');
	lines.push('');
	lines.push('```mermaid');
	lines.push(...generateMermaidErDiagram(result));
	lines.push('```');
	lines.push('');

	// Entities
	lines.push('## Entities');
	lines.push('');

	for (const entity of result.entities) {
		lines.push(...formatEntitySection(entity));
	}

	// Issues
	const errors = result.issues.filter((i) => i.severity === 'error');
	const warnings = result.issues.filter((i) => i.severity === 'warning');
	const infos = result.issues.filter((i) => i.severity === 'info');

	if (result.issues.length > 0) {
		lines.push('## Analysis Issues');
		lines.push('');

		if (errors.length > 0) {
			lines.push('### Errors');
			lines.push('');
			for (const issue of errors) {
				const location = issue.entity
					? `**${issue.entity}${issue.field ? '.' + issue.field : ''}**`
					: issue.path ?? 'unknown';
				lines.push(`- [${issue.type}] ${location}: ${issue.message}`);
				if (issue.suggestion) {
					lines.push(`  - Suggestion: ${issue.suggestion}`);
				}
			}
			lines.push('');
		}

		if (warnings.length > 0) {
			lines.push('### Warnings');
			lines.push('');
			for (const issue of warnings) {
				const location = issue.entity
					? `**${issue.entity}${issue.field ? '.' + issue.field : ''}**`
					: issue.path ?? 'unknown';
				lines.push(`- [${issue.type}] ${location}: ${issue.message}`);
				if (issue.suggestion) {
					lines.push(`  - Suggestion: ${issue.suggestion}`);
				}
			}
			lines.push('');
		}

		if (infos.length > 0) {
			lines.push('### Info');
			lines.push('');
			lines.push('<details>');
			lines.push('<summary>Show info messages</summary>');
			lines.push('');
			for (const issue of infos) {
				const location = issue.entity
					? `**${issue.entity}${issue.field ? '.' + issue.field : ''}**`
					: issue.path ?? 'unknown';
				lines.push(`- [${issue.type}] ${location}: ${issue.message}`);
			}
			lines.push('');
			lines.push('</details>');
			lines.push('');
		}
	}

	return lines.join('\n');
}

/**
 * Format a single entity section
 */
function formatEntitySection(entity: ParsedEntity): string[] {
	const lines: string[] = [];

	lines.push(`### ${entity.name}`);
	lines.push('');
	lines.push(`**Table:** \`${entity.table}\``);
	lines.push(`**Plural:** ${entity.plural}`);
	if (entity.behaviors.length > 0) {
		lines.push(`**Behaviors:** ${entity.behaviors.join(', ')}`);
	}
	lines.push('');

	// Fields table
	lines.push('#### Fields');
	lines.push('');
	lines.push('| Name | Type | Required | Nullable | Index | Foreign Key |');
	lines.push('|------|------|----------|----------|-------|-------------|');

	for (const [name, field] of entity.fields) {
		const required = field.required ? 'Yes' : '';
		const nullable = field.nullable ? 'Yes' : '';
		const index = field.index ? 'Yes' : field.unique ? 'Unique' : '';
		const fk = field.foreignKey ? `${field.foreignKey.table}.${field.foreignKey.column}` : '';
		lines.push(`| ${name} | ${field.type} | ${required} | ${nullable} | ${index} | ${fk} |`);
	}
	lines.push('');

	// Relationships
	if (entity.relationships.size > 0) {
		lines.push('#### Relationships');
		lines.push('');
		lines.push('| Name | Type | Target | Foreign Key |');
		lines.push('|------|------|--------|-------------|');

		for (const [name, rel] of entity.relationships) {
			lines.push(`| ${name} | ${rel.type} | ${rel.target} | ${rel.foreignKey} |`);
		}
		lines.push('');
	}

	return lines;
}

/**
 * Generate Mermaid ER diagram
 */
function generateMermaidErDiagram(result: AnalysisResult): string[] {
	const lines: string[] = [];

	lines.push('erDiagram');

	// Define entities with their fields
	for (const entity of result.entities) {
		const entityName = entity.name.toUpperCase();
		lines.push(`    ${entityName} {`);

		// Show key fields only (to keep diagram readable)
		const keyFields = Array.from(entity.fields.entries())
			.filter(
				([name, field]) =>
					field.foreignKey || field.unique || field.index || name === 'id' || name === 'name'
			)
			.slice(0, 6); // Limit to 6 fields

		for (const [name, field] of keyFields) {
			const typeStr = field.type;
			const pk = name === 'id' ? 'PK' : '';
			const fk = field.foreignKey ? 'FK' : '';
			const marker = pk || fk ? ` "${pk}${fk}"` : '';
			lines.push(`        ${typeStr} ${name}${marker}`);
		}

		if (entity.fields.size > keyFields.length) {
			lines.push(`        string _more_fields`);
		}

		lines.push('    }');
	}

	// Add relationships
	for (const edge of result.graph.edges) {
		const from = edge.from.toUpperCase();
		const to = edge.to.toUpperCase();
		const cardinalitySymbol = getCardinalitySymbol(edge.cardinality);
		const label = edge.relationship.name;

		lines.push(`    ${from} ${cardinalitySymbol} ${to} : "${label}"`);
	}

	return lines;
}

/**
 * Get Mermaid cardinality symbol
 */
function getCardinalitySymbol(cardinality: string): string {
	switch (cardinality) {
		case '1:N':
			return '||--o{';
		case 'N:1':
			return '}o--||';
		case '1:1':
			return '||--||';
		case 'N:M':
			return '}o--o{';
		default:
			return '||--o{';
	}
}

/**
 * Generate a simple relationship graph in Mermaid
 */
export function formatMermaidGraph(result: AnalysisResult): string {
	const lines: string[] = [];

	lines.push('```mermaid');
	lines.push('graph LR');

	// Style definitions
	lines.push('    classDef entity fill:#e1f5fe,stroke:#01579b');

	// Add entities as nodes
	for (const entity of result.entities) {
		lines.push(`    ${entity.name}["${entity.name}\\n(${entity.fields.size} fields)"]`);
	}

	// Add relationships as edges
	for (const edge of result.graph.edges) {
		const style = edge.bidirectional ? '<-->' : '-->';
		lines.push(`    ${edge.from} ${style}|${edge.relationship.type}| ${edge.to}`);
	}

	// Apply styles
	const entityList = result.entities.map((e) => e.name).join(',');
	if (entityList) {
		lines.push(`    class ${entityList} entity`);
	}

	lines.push('```');

	return lines.join('\n');
}
