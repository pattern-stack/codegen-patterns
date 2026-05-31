/**
 * Provider Cross-Validator (RFC-0001 §1, D1)
 *
 * Runs after the per-file `ProviderDefinitionSchema` parse (which owns the
 * intra-file contract). This module owns the rules a single-file parse cannot
 * express because they need the whole provider set and/or filesystem access:
 *
 *   1. `slug` is unique across `definitions/providers/`.
 *   2. each `surfaces[]` value references a real `surface:` declared on some
 *      `definitions/entities/*.yaml` (the union is the closed set; a surface
 *      with no entities is an error — nothing to adapt). Emptiness is caught
 *      upstream by the schema's `.min(1)`.
 *   3. pre-flight import resolution: `auth.strategy` and `client.class`
 *      (`import-path#Export`) resolve to a real export at codegen time, so a
 *      typo fails `cdp gen` with a clear message rather than a NestJS DI
 *      failure three layers removed from the cause (RFC-0001 §1).
 *
 * Framework-agnostic and pure w.r.t. its inputs — it only *reads* the
 * filesystem to resolve import refs. The CLI surfaces the returned issues.
 *
 * D1 scope: validation only. No emission.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import ts from "typescript";
import type { AnalysisIssue } from "../analyzer/types";
import {
  parseImportRef,
  type ProviderDefinition,
} from "../schema/provider-definition.schema";

// ============================================================================
// Inputs
// ============================================================================

/** A successfully-loaded provider plus the file it came from. */
export interface LoadedProvider {
  definition: ProviderDefinition;
  filePath: string;
}

export interface ValidateProvidersOptions {
  /**
   * The closed set of surfaces declared across all entity YAML — every
   * `provider.surfaces[]` value must be a member. Use
   * {@link collectEntitySurfaces} to build it.
   */
  entitySurfaces: Set<string> | Iterable<string>;
  /**
   * Base directory the import refs resolve against (the consumer source root).
   * Required unless `skipImportCheck` is set.
   */
  sourceRoot?: string;
  /**
   * Path-alias prefixes → absolute directories, e.g. `{ '@app': '/abs/src' }`.
   * A ref whose path matches `<alias>` or `<alias>/…` resolves under the mapped
   * directory; otherwise the ref resolves relative to `sourceRoot`. Wiring this
   * from the consumer tsconfig `paths` is D2+; D1 takes it as an explicit input.
   */
  aliases?: Record<string, string>;
  /**
   * Escape hatch: skip the filesystem-bound import pre-flight (e.g. when the
   * consumer source root is not available in the current context). Slug and
   * surface checks still run.
   */
  skipImportCheck?: boolean;
}

// ============================================================================
// Entity-surface union
// ============================================================================

/**
 * Build the closed set of surfaces from loaded entity definitions — the union
 * of every entity's optional `surface:` value. Entities without a surface
 * contribute nothing.
 */
export function collectEntitySurfaces(
  entities: Iterable<{ surface?: string }>,
): Set<string> {
  const surfaces = new Set<string>();
  for (const e of entities) {
    if (e.surface) surfaces.add(e.surface);
  }
  return surfaces;
}

// ============================================================================
// Import-ref pre-flight
// ============================================================================

export type ImportRefResolution =
  | { status: "ok"; file: string }
  | { status: "module-not-found"; resolvedFrom: string }
  | { status: "export-not-found"; file: string };

/**
 * Resolve an `import-path#Export` ref against the source tree and confirm the
 * named export exists.
 *
 * Module resolution: a path matching a configured alias is rewritten under the
 * mapped directory; otherwise it resolves relative to `sourceRoot`. Candidate
 * files tried in order: the path as-is, `.ts`, `.tsx`, `/index.ts`,
 * `/index.tsx`.
 *
 * Export resolution uses the TypeScript parser (not regex) so `export class`,
 * `export const`, `export { X as Name }`, re-exports, and namespace exports are
 * all recognised. A bare `export * from '…'` re-export cannot be disproven
 * without following it, so a ref that matches no concrete export but the module
 * carries a wildcard re-export is treated as resolvable (documented limitation;
 * the typo class this guards is a misspelt path or export *name*, both of which
 * still fail).
 */
export function resolveImportRef(
  ref: string,
  opts: { sourceRoot: string; aliases?: Record<string, string> },
): ImportRefResolution {
  const { path, exportName } = parseImportRef(ref);
  const file = resolveModuleFile(path, opts);
  if (!file) {
    return { status: "module-not-found", resolvedFrom: opts.sourceRoot };
  }

  const content = readFileSync(file, "utf-8");
  const { names, hasWildcard } = collectExportedNames(file, content);
  if (names.has(exportName) || hasWildcard) {
    return { status: "ok", file };
  }
  return { status: "export-not-found", file };
}

function resolveModuleFile(
  importPath: string,
  opts: { sourceRoot: string; aliases?: Record<string, string> },
): string | null {
  let base: string | null = null;

  for (const [alias, target] of Object.entries(opts.aliases ?? {})) {
    if (importPath === alias || importPath.startsWith(`${alias}/`)) {
      const rest = importPath.slice(alias.length); // includes leading '/' or ''
      base = join(target, rest);
      break;
    }
  }

  if (base === null) {
    base = isAbsolute(importPath)
      ? importPath
      : resolve(opts.sourceRoot, importPath);
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function collectExportedNames(
  fileName: string,
  content: string,
): { names: Set<string>; hasWildcard: boolean } {
  const sf = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const names = new Set<string>();
  let hasWildcard = false;

  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ??
      false);

  sf.forEachChild((node) => {
    if (hasExportModifier(node)) {
      if (
        (ts.isClassDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node) ||
          ts.isModuleDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        names.add(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause) {
        hasWildcard = true; // export * from '…'
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) names.add(el.name.text);
      } else if (ts.isNamespaceExport(node.exportClause)) {
        names.add(node.exportClause.name.text); // export * as ns from '…'
      }
    }
  });

  return { names, hasWildcard };
}

// ============================================================================
// Cross-validator
// ============================================================================

/**
 * Cross-validate a set of loaded providers. Never throws — always returns an
 * array of {@link AnalysisIssue} (all `severity: 'error'` for D1's gates).
 */
export function validateProviders(
  providers: LoadedProvider[],
  opts: ValidateProvidersOptions,
): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];
  const knownSurfaces = new Set(opts.entitySurfaces);

  // 1. slug uniqueness across the providers dir.
  const slugToFiles = new Map<string, string[]>();
  for (const p of providers) {
    const files = slugToFiles.get(p.definition.slug) ?? [];
    files.push(p.filePath);
    slugToFiles.set(p.definition.slug, files);
  }
  for (const [slug, files] of slugToFiles) {
    if (files.length > 1) {
      for (const file of files) {
        const others = files.filter((f) => f !== file);
        issues.push({
          severity: "error",
          type: "provider_duplicate_slug",
          message: `provider slug '${slug}' is declared more than once (also in: ${others.join(", ")})`,
          path: file,
        });
      }
    }
  }

  for (const { definition, filePath } of providers) {
    const { slug } = definition;

    // 2. surfaces[] ⊆ entity surface union.
    for (const surface of definition.surfaces) {
      if (!knownSurfaces.has(surface)) {
        const known = [...knownSurfaces].sort().join(", ") || "(none declared)";
        issues.push({
          severity: "error",
          type: "provider_unknown_surface",
          message: `provider ${slug}: surface '${surface}' is not declared by any entity (known surfaces: ${known})`,
          path: filePath,
        });
      }
    }

    // 3. pre-flight import resolution for auth.strategy + client.class.
    if (!opts.skipImportCheck) {
      if (!opts.sourceRoot) {
        throw new Error(
          "validateProviders: sourceRoot is required for the import pre-flight check (or set skipImportCheck: true)",
        );
      }
      const resolveOpts = {
        sourceRoot: opts.sourceRoot,
        aliases: opts.aliases,
      };
      const refs: Array<{ field: string; ref: string }> = [
        { field: "auth.strategy", ref: definition.auth.strategy },
        { field: "client.class", ref: definition.client.class },
      ];
      for (const { field, ref } of refs) {
        const result = resolveImportRef(ref, resolveOpts);
        if (result.status === "module-not-found") {
          issues.push({
            severity: "error",
            type: "provider_import_unresolved",
            message: `provider ${slug}: ${field} '${ref}' not found — module could not be resolved from ${result.resolvedFrom}`,
            path: filePath,
          });
        } else if (result.status === "export-not-found") {
          const { exportName } = parseImportRef(ref);
          issues.push({
            severity: "error",
            type: "provider_import_unresolved",
            message: `provider ${slug}: ${field} '${ref}' not found — export '${exportName}' is missing from ${result.file}`,
            path: filePath,
          });
        }
      }
    }
  }

  return issues;
}
