/**
 * A path local the CLI resolves from the project's `paths.*` and passes to a
 * subsystem prompt (`src/cli/shared/*-scaffold-locals.ts` → `project-layout.ts`).
 * The prompt has no fallback of its own: a second default here is exactly the
 * divergence PATH-0 (#642) removed. Missing ⇒ the prompt was not run through
 * the CLI, and it says so.
 */
export function requiredPathArg(args, name, generator) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${generator}: --${name} is required (the CLI resolves it from codegen.config.yaml paths.*; run \`codegen subsystem install\`)`,
    );
  }
  return value;
}
