/**
 * Events noun — fanout discovery + summary.
 *
 * BRIDGE-9 ships the first verb under this noun: `events consumers <type>`.
 * It indexes all three tiers from ADR-023 §Three tiers of event-driven work
 * and prints one greppable report per event type:
 *
 *   - Tier 3 (bridge):  bridgeRegistry entries declared on `@JobHandler.triggers`
 *   - Tier 2 (facade):  AST scan for `<expr>.publishAndStart(<type>, ...)`
 *   - Tier 1 (subscr.): AST scan for `@OnEvent(<type>)` and
 *                       `<expr>.subscribe(<type>, ...)` call sites
 *
 * Default scan root is `<cwd>/src/` (no config knob in Phase 2; Phase 2.5 may
 * add one). Exit 0 always — empty results print "(no consumers found)" and
 * unknown event types warn-to-stderr and exit 0 (consistent with the rest of
 * the codegen CLI's "tools never gate CI" stance).
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { Command, Option } from 'clipanion';
import type { CommandClass } from 'clipanion';

import { loadContext, type Context } from '../shared/context.js';
import {
	findHandlerFiles,
	scanHandlerFiles,
	readKnownEventTypes,
} from '../shared/bridge-registry-generator.js';
import { resolveSubsystemsRoot } from '../shared/subsystems-path.js';
import { theme } from '../ui/theme.js';
import { icons } from '../ui/icons.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';
import type { PaneOutput } from '../ui/pane.js';
import type { Hint } from '../ui/hints.js';
import type { NounModule } from '../noun-module.js';

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------

export interface Tier3Hit {
	triggerId: string;
	jobType: string;
	sourceFile: string;
	sourceLine: number;
}

export interface Tier2Hit {
	sourceFile: string;
	sourceLine: number;
	/** The receiver expression text — `eventFlow`, `this.eventFlow`, etc. */
	receiverText: string;
}

export interface Tier1Hit {
	kind: 'on-event' | 'subscribe';
	/** ClassName.methodOrProperty for @OnEvent; receiver expr for subscribe. */
	siteLabel: string;
	sourceFile: string;
	sourceLine: number;
}

export interface ConsumerScanResult {
	eventType: string;
	tier3: Tier3Hit[];
	tier2: Tier2Hit[];
	tier1: Tier1Hit[];
	/** True when EventFlowService is imported anywhere in the scan root. */
	eventFlowServicePresent: boolean;
	/** True when `eventType` appears in the generated eventRegistry. */
	knownEventType: boolean;
	/** Closest known event types when `knownEventType` is false (max 3). */
	suggestions: string[];
}

// ---------------------------------------------------------------------------
// Tier 2 / Tier 1 AST scanner
// ---------------------------------------------------------------------------

/**
 * Walk a parsed source file and collect Tier 2 + Tier 1 hits matching the
 * requested event type. Also flags whether `EventFlowService` is imported
 * (used for the fallback warn when Tier 2 returns zero hits).
 *
 * Match rules (all conservative — false-negatives are acceptable, false-
 * positives are not):
 *   - Tier 2: a call expression whose method name is `publishAndStart` and
 *     whose first argument is a string literal equal to `eventType`. The
 *     receiver text is captured for the report.
 *   - Tier 1 (subscribe): same shape with method name `subscribe`.
 *   - Tier 1 (decorator): a method/property decorator named `OnEvent` whose
 *     first argument is a string literal equal to `eventType`. The site
 *     label is `<EnclosingClass>.<member>`.
 *
 * `EventFlowService` import detection: any `import` declaration whose
 * specifier text is `EventFlowService` OR `EVENT_FLOW`, OR whose module
 * path contains `subsystems/bridge`.
 */
export function scanSourceFileForConsumers(
	sourceFile: ts.SourceFile,
	filePath: string,
	eventType: string,
): {
	tier2: Tier2Hit[];
	tier1: Tier1Hit[];
	hasEventFlowImport: boolean;
} {
	const tier2: Tier2Hit[] = [];
	const tier1: Tier1Hit[] = [];
	let hasEventFlowImport = false;

	function lineOf(node: ts.Node): number {
		const { line } = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(sourceFile),
		);
		return line + 1;
	}

	function checkImport(node: ts.ImportDeclaration): void {
		const moduleSpec = node.moduleSpecifier;
		if (ts.isStringLiteral(moduleSpec) && moduleSpec.text.includes('subsystems/bridge')) {
			hasEventFlowImport = true;
		}
		const clause = node.importClause;
		if (!clause) return;
		const named = clause.namedBindings;
		if (named && ts.isNamedImports(named)) {
			for (const el of named.elements) {
				const name = el.name.text;
				if (name === 'EventFlowService' || name === 'EVENT_FLOW') {
					hasEventFlowImport = true;
				}
			}
		}
	}

	function checkCall(node: ts.CallExpression): void {
		// Only property-access call shapes: <expr>.method(...)
		if (!ts.isPropertyAccessExpression(node.expression)) return;
		const methodName = node.expression.name.text;
		if (methodName !== 'publishAndStart' && methodName !== 'subscribe') return;
		const firstArg = node.arguments[0];
		if (!firstArg || !ts.isStringLiteralLike(firstArg)) return;
		if (firstArg.text !== eventType) return;
		const receiverText = node.expression.expression.getText(sourceFile);
		if (methodName === 'publishAndStart') {
			tier2.push({
				sourceFile: filePath,
				sourceLine: lineOf(node),
				receiverText,
			});
		} else {
			tier1.push({
				kind: 'subscribe',
				siteLabel: `${receiverText}.subscribe('${eventType}', ...)`,
				sourceFile: filePath,
				sourceLine: lineOf(node),
			});
		}
	}

	function findEnclosingClassName(node: ts.Node): string | null {
		let cur: ts.Node | undefined = node.parent;
		while (cur) {
			if (ts.isClassDeclaration(cur) && cur.name) return cur.name.text;
			if (ts.isClassExpression(cur) && cur.name) return cur.name.text;
			cur = cur.parent;
		}
		return null;
	}

	function checkDecoratorOn(member: ts.MethodDeclaration | ts.PropertyDeclaration): void {
		const decorators = ts.canHaveDecorators(member)
			? ts.getDecorators(member) ?? []
			: [];
		for (const decorator of decorators) {
			const call = decorator.expression;
			if (!ts.isCallExpression(call)) continue;
			if (!ts.isIdentifier(call.expression)) continue;
			if (call.expression.text !== 'OnEvent') continue;
			const firstArg = call.arguments[0];
			if (!firstArg || !ts.isStringLiteralLike(firstArg)) continue;
			if (firstArg.text !== eventType) continue;
			const className = findEnclosingClassName(member) ?? '<anonymous>';
			const memberName = ts.isIdentifier(member.name)
				? member.name.text
				: member.name.getText(sourceFile);
			tier1.push({
				kind: 'on-event',
				siteLabel: `${className}.${memberName} @OnEvent('${eventType}')`,
				sourceFile: filePath,
				sourceLine: lineOf(decorator),
			});
		}
	}

	function visit(node: ts.Node): void {
		if (ts.isImportDeclaration(node)) checkImport(node);
		if (ts.isCallExpression(node)) checkCall(node);
		if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
			checkDecoratorOn(node);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return { tier2, tier1, hasEventFlowImport };
}

/**
 * Scan a directory tree for Tier 2 + Tier 1 consumers of `eventType`. Reuses
 * `findHandlerFiles` for the file walker (skips node_modules, generated,
 * dotfiles, .d.ts).
 */
export function scanDirectoryForConsumers(
	rootDir: string,
	eventType: string,
): {
	tier2: Tier2Hit[];
	tier1: Tier1Hit[];
	hasEventFlowImport: boolean;
} {
	const files = findHandlerFiles(rootDir);
	const tier2: Tier2Hit[] = [];
	const tier1: Tier1Hit[] = [];
	let hasEventFlowImport = false;

	for (const filePath of files) {
		const text = fs.readFileSync(filePath, 'utf8');
		const sourceFile = ts.createSourceFile(
			filePath,
			text,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const result = scanSourceFileForConsumers(sourceFile, filePath, eventType);
		tier2.push(...result.tier2);
		tier1.push(...result.tier1);
		if (result.hasEventFlowImport) hasEventFlowImport = true;
	}

	return { tier2, tier1, hasEventFlowImport };
}

// ---------------------------------------------------------------------------
// Suggestion (closest event type)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const dp: number[] = new Array(n + 1).fill(0).map((_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
			prev = tmp;
		}
	}
	return dp[n];
}

export function suggestEventTypes(
	target: string,
	known: string[],
	limit = 3,
): string[] {
	return known
		.map((t) => ({ t, d: levenshtein(target, t) }))
		.sort((a, b) => a.d - b.d)
		.slice(0, limit)
		.map((x) => x.t);
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

/**
 * Render the lead-approved exact format. Empty tiers show `(none)` so the
 * output is greppable; total-zero adds a "(no consumers found)" header.
 */
export function renderConsumerReport(result: ConsumerScanResult, cwd: string): string[] {
	const rel = (p: string) => path.relative(cwd, p) || p;
	const lines: string[] = [];

	const total = result.tier3.length + result.tier2.length + result.tier1.length;
	lines.push(`Event: ${result.eventType}`);
	if (total === 0) {
		lines.push('(no consumers found)');
	}

	lines.push(`Tier 3 — Bridge triggers (${result.tier3.length}):`);
	if (result.tier3.length === 0) {
		lines.push('  - (none)');
	} else {
		const labelWidth =
			Math.max(...result.tier3.map((h) => h.triggerId.length)) + 2;
		for (const h of result.tier3) {
			const padded = h.triggerId.padEnd(labelWidth);
			lines.push(`  - ${padded}(${rel(h.sourceFile)}:${h.sourceLine})`);
		}
	}

	lines.push(`Tier 2 — Direct invoke via publishAndStart (${result.tier2.length}):`);
	if (result.tier2.length === 0) {
		lines.push('  - (none)');
	} else {
		for (const h of result.tier2) {
			lines.push(`  - ${rel(h.sourceFile)}:${h.sourceLine}`);
		}
	}

	lines.push(`Tier 1 — Subscribers (${result.tier1.length}):`);
	if (result.tier1.length === 0) {
		lines.push('  - (none)');
	} else {
		for (const h of result.tier1) {
			lines.push(`  - ${h.siteLabel} at ${rel(h.sourceFile)}:${h.sourceLine}`);
		}
	}

	return lines;
}

// ---------------------------------------------------------------------------
// EventsConsumersCommand
// ---------------------------------------------------------------------------

export interface RunConsumersScanOptions {
	cwd: string;
	config: Context['config'];
	eventType: string;
	/** Override the default `<cwd>/src/` scan root (tests). */
	scanRoot?: string;
	/** Override the handler dir scanned for Tier 3 triggers (tests). */
	handlersDir?: string;
	/** Override the events generated dir for known-event-type validation (tests). */
	eventsGeneratedDir?: string;
}

/**
 * Run the full three-tier scan. Exposed for unit tests; the CLI command
 * forwards into this and renders the result.
 */
export function runConsumersScan(
	opts: RunConsumersScanOptions,
): ConsumerScanResult {
	const scanRoot = opts.scanRoot ?? path.join(opts.cwd, 'src');
	const handlersDir = opts.handlersDir ?? scanRoot;

	// Tier 3 — re-scan handler decorators for full file:line info. (We could
	// also import the generated registry, but the registry doesn't carry
	// source positions; re-scanning is what gives the report citations.)
	const allTriggers = scanHandlerFiles(handlersDir);
	const tier3: Tier3Hit[] = allTriggers
		.filter((t) => t.event === opts.eventType)
		.map((t) => ({
			triggerId: t.triggerId,
			jobType: t.jobType,
			sourceFile: t.sourceFile,
			sourceLine: t.sourceLine,
		}));

	// Tier 2 + Tier 1 — AST scan src tree for call/decorator sites.
	const tier21 = fs.existsSync(scanRoot)
		? scanDirectoryForConsumers(scanRoot, opts.eventType)
		: { tier2: [], tier1: [], hasEventFlowImport: false };

	// Known-event validation — read events/generated/registry.ts.
	const eventsGeneratedDir =
		opts.eventsGeneratedDir ??
		path.join(
			resolveSubsystemsRootFromContext(opts.cwd, opts.config),
			'events',
			'generated',
		);
	const knownEventTypes = readKnownEventTypes(eventsGeneratedDir);
	const knownEventType = knownEventTypes.includes(opts.eventType);
	const suggestions = knownEventType
		? []
		: suggestEventTypes(opts.eventType, knownEventTypes, 3);

	return {
		eventType: opts.eventType,
		tier3,
		tier2: tier21.tier2,
		tier1: tier21.tier1,
		eventFlowServicePresent: tier21.hasEventFlowImport,
		knownEventType,
		suggestions,
	};
}

function resolveSubsystemsRootFromContext(
	cwd: string,
	config: Context['config'],
): string {
	// Lazy import to avoid Context coupling in pure-test paths.
	// Mirrors `subsystems-path.ts:resolveSubsystemsRootFromConfig` semantics.
	const configured = (config as { paths?: { subsystems?: string } } | null)?.paths
		?.subsystems;
	if (typeof configured === 'string' && configured.length > 0) {
		return path.resolve(cwd, configured);
	}
	const backendSrc = (config as { paths?: { backend_src?: string } } | null)?.paths
		?.backend_src;
	const base =
		typeof backendSrc === 'string' && backendSrc.length > 0 ? backendSrc : 'src';
	return path.resolve(cwd, base, 'shared', 'subsystems');
}

export class EventsConsumersCommand extends Command {
	static paths = [['events', 'consumers']];
	static usage = Command.Usage({
		description: 'List all consumers of an event across the three tiers',
		examples: [
			[
				'Index every consumer of `user.created`',
				'codegen events consumers user.created',
			],
		],
	});

	eventType = Option.String({ required: true });
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({
			cwd: this.cwd,
			configPath: this.configPath,
			json: this.json,
			skipDetection: true,
		});

		const result = runConsumersScan({
			cwd: ctx.cwd,
			config: ctx.config,
			eventType: this.eventType,
		});

		// Unknown event-type → warn-to-stderr (still exit 0).
		if (!result.knownEventType) {
			const suggestionPart =
				result.suggestions.length > 0
					? ` Did you mean one of: ${result.suggestions.join(', ')}?`
					: '';
			console.warn(
				`[events consumers] WARN: event type '${this.eventType}' is not declared in eventRegistry.${suggestionPart}`,
			);
		}

		// Tier 2 fallback warn — zero hits but EventFlowService imported.
		if (result.tier2.length === 0 && result.eventFlowServicePresent) {
			console.warn(
				`[events consumers] WARN: no \`publishAndStart('${this.eventType}', ...)\` call sites found, but EventFlowService is present in the codebase. The scan may miss non-standard injection patterns (e.g., property injection, dynamic dispatch). Grep for \`publishAndStart\` to verify Tier 2 fanout manually.`,
			);
		}

		if (isJsonMode()) {
			printJson({
				command: 'events consumers',
				eventType: result.eventType,
				knownEventType: result.knownEventType,
				suggestions: result.suggestions,
				eventFlowServicePresent: result.eventFlowServicePresent,
				tier3: result.tier3,
				tier2: result.tier2,
				tier1: result.tier1,
			});
			return 0;
		}

		const lines = renderConsumerReport(result, ctx.cwd);
		for (const line of lines) {
			console.log(line);
		}

		return 0;
	}
}

// ---------------------------------------------------------------------------
// Noun module — summary + hints
// ---------------------------------------------------------------------------

async function summary(_ctx: Context): Promise<PaneOutput> {
	return {
		title: 'events',
		body: [
			theme.muted('Events subsystem — typed registry, transactional outbox.'),
			'',
			theme.muted('Discovery:'),
			`  ${theme.muted(icons.dash)} ${theme.system('codegen events consumers <type>')}  ${theme.muted('— index Tier 1/2/3 consumers')}`,
		],
	};
}

async function hints(_ctx: Context): Promise<Hint[]> {
	return [
		{
			command: 'codegen events consumers <type>',
			description: 'List all consumers of an event across the three tiers',
		},
	];
}

const eventsNoun: NounModule = {
	name: 'events',
	commandClasses: [EventsConsumersCommand] as CommandClass[],
	summary,
	hints,
};

export default eventsNoun;
