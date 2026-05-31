import { z } from "zod";

/**
 * Provider Definition Schema (RFC-0001 §1)
 *
 * Providers are first-class declarative artifacts living at
 * `definitions/providers/<provider>.yaml`, flat and sibling to
 * `definitions/entities/`. They are the single source of provider truth —
 * auth strategy, API client, and the surfaces a provider serves —
 * superseding ADR-034's `codegen.config.yaml providers:` block.
 *
 * This module owns the *intra-file* contract (shape + within-file rules such
 * as "scopes required iff oauth2" and the `import-path#Export` reference
 * format). *Cross-file* rules — slug uniqueness across the providers dir,
 * `surfaces[]` ⊆ the union of entity `surface:` declarations, and the
 * pre-flight resolution of `auth.strategy` / `client.class` against real
 * exports on disk — live in `src/parser/validate-providers.ts`, because they
 * need the whole provider set and filesystem access that a single-file Zod
 * parse does not have.
 *
 * D1 scope: schema + validation only. Provider/adapter emission is D2+.
 */

// ============================================================================
// Import reference (`import-path#Export`)
// ============================================================================

/**
 * `auth.strategy` and `client.class` are written as `import-path#Export`, e.g.
 * `@app/integrations/providers/google/google-oauth.strategy#GoogleOAuthStrategy`.
 *
 * The schema validates the *format* only: a non-empty path, a single `#`, and
 * a valid JS identifier for the export. Whether that export actually exists is
 * a codegen-time, filesystem-bound check performed pre-flight by
 * `validateProviders()` (RFC-0001 §1 "Validation (pre-flight)").
 */
export const IMPORT_REF_RE = /^[^#\s]+#[A-Za-z_$][A-Za-z0-9_$]*$/;

const ImportRefSchema = z
  .string()
  .regex(
    IMPORT_REF_RE,
    "must be an 'import-path#Export' reference (e.g. '@app/foo/bar.strategy#BarStrategy')",
  );

/**
 * Split an `import-path#Export` reference into its two halves. Assumes the ref
 * has already passed `IMPORT_REF_RE` (single `#`, valid identifier).
 */
export function parseImportRef(ref: string): { path: string; exportName: string } {
  const hash = ref.indexOf("#");
  return { path: ref.slice(0, hash), exportName: ref.slice(hash + 1) };
}

// ============================================================================
// Auth
// ============================================================================

/**
 * `auth.type` gates which sub-fields are required. `scopes` is required iff
 * `oauth2`. The `…` in RFC-0001 §1 signals this enum will grow as new auth
 * shapes land; additions go here.
 */
export const AuthTypeSchema = z.enum(["oauth2", "api-key", "app-password"]);

export type AuthType = z.infer<typeof AuthTypeSchema>;

const AuthSchema = z
  .object({
    type: AuthTypeSchema,
    // Class implementing the auth subsystem's strategy contract (ADR-031).
    // Pre-flight verified against a real export at codegen time.
    strategy: ImportRefSchema,
    // Required (and non-empty) iff type === 'oauth2'; see refine below.
    scopes: z.array(z.string()).optional(),
  })
  .strict()
  .refine(
    (a) => a.type !== "oauth2" || (a.scopes !== undefined && a.scopes.length > 0),
    {
      message:
        "auth.scopes is required and must be non-empty when auth.type is 'oauth2'",
      path: ["scopes"],
    },
  );

// ============================================================================
// Client
// ============================================================================

const ClientSchema = z
  .object({
    // API client class. Pre-flight verified against a real export.
    class: ImportRefSchema,
    base_url: z.string().url("client.base_url must be an absolute URL"),
  })
  .strict();

// ============================================================================
// Full Provider Definition
// ============================================================================

export const ProviderDefinitionSchema = z
  .object({
    // Provider id — the canonical string used as detection: keys, audit rows,
    // subscription rows. kebab/lower; unique across definitions/providers/
    // (uniqueness is a cross-file check in validate-providers.ts).
    slug: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*$/,
        "slug must be kebab-case lower (e.g. 'google', 'hubspot')",
      ),
    display_name: z.string().optional(),
    auth: AuthSchema,
    client: ClientSchema,
    // Surfaces this provider serves (ADR-0006: surfaces span contexts — one
    // Google OAuth feeds calendar+mail+transcript). Each must reference a real
    // `surface:` declared on some entity; that cross-check is in
    // validate-providers.ts. Non-empty enforced here.
    surfaces: z
      .array(z.string())
      .min(1, "surfaces must list at least one surface"),
    // Optional auth lifecycle hints consumed by provider-module emission (D2).
    // `refresh_behavior` is left as a free string in D1 — its domain firms up
    // when D2 consumes it; carrying it now keeps the YAML lossless.
    token_lifetime: z.number().int().positive().optional(),
    refresh_behavior: z.string().optional(),
  })
  .strict();

export type ProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateProviderDefinition(data: unknown): ProviderDefinition {
  return ProviderDefinitionSchema.parse(data);
}

export function safeValidateProviderDefinition(data: unknown): {
  success: boolean;
  data?: ProviderDefinition;
  error?: z.ZodError;
} {
  const result = ProviderDefinitionSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
