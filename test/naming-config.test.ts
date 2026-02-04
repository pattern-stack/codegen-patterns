/**
 * Naming Configuration Test Suite
 *
 * Tests for the backend naming configuration system:
 * - Schema validation
 * - Config loader
 * - File name computation
 * - Backward compatibility
 */

import { describe, test, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import {
  BackendNamingConfigSchema,
  FileCaseSchema,
  SuffixStyleSchema,
  EntityInclusionSchema,
  TerminologySchema,
  DEFAULT_BACKEND_NAMING,
  resolveLayerNaming,
  validateBackendNamingConfig,
  safeValidateBackendNamingConfig,
  FILE_TYPE_SUFFIXES,
} from "../schema/naming-config.schema.ts";
import {
  toKebabCase,
  toSnakeCase,
  toCamelCase,
  toPascalCase,
  applyCase,
} from "../config/case-converters.mjs";
import {
  computeFileName,
  computeFileNaming,
  getEntityFileNames,
} from "../config/paths.mjs";

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe("BackendNamingConfigSchema", () => {
  describe("Valid configurations", () => {
    test("parses complete config successfully", () => {
      const config = {
        fileCase: "snake_case",
        suffixStyle: "dotted",
        entityInclusion: "always",
        terminology: { command: "command", query: "query" },
      };
      const result = BackendNamingConfigSchema.parse(config);
      expect(result.fileCase).toBe("snake_case");
      expect(result.suffixStyle).toBe("dotted");
      expect(result.entityInclusion).toBe("always");
    });

    test("applies defaults for missing fields", () => {
      const result = BackendNamingConfigSchema.parse({});
      expect(result.fileCase).toBe("kebab-case");
      expect(result.suffixStyle).toBe("dotted");
      expect(result.entityInclusion).toBe("flat-only");
      expect(result.terminology.command).toBe("command");
      expect(result.terminology.query).toBe("query");
    });

    test("parses partial config with defaults", () => {
      const result = BackendNamingConfigSchema.parse({
        fileCase: "PascalCase",
      });
      expect(result.fileCase).toBe("PascalCase");
      expect(result.suffixStyle).toBe("dotted"); // default
    });

    test("supports per-layer overrides", () => {
      const config = {
        fileCase: "snake_case",
        layers: {
          domain: { fileCase: "PascalCase", suffixStyle: "suffixed" },
        },
      };
      const result = BackendNamingConfigSchema.parse(config);
      expect(result.layers?.domain?.fileCase).toBe("PascalCase");
      expect(result.layers?.domain?.suffixStyle).toBe("suffixed");
    });
  });

  describe("Invalid configurations", () => {
    test("rejects invalid fileCase", () => {
      expect(() => {
        BackendNamingConfigSchema.parse({ fileCase: "SCREAMING_CASE" });
      }).toThrow();
    });

    test("rejects invalid suffixStyle", () => {
      expect(() => {
        BackendNamingConfigSchema.parse({ suffixStyle: "prefixed" });
      }).toThrow();
    });

    test("rejects invalid entityInclusion", () => {
      expect(() => {
        BackendNamingConfigSchema.parse({ entityInclusion: "sometimes" });
      }).toThrow();
    });

    test("rejects invalid terminology command", () => {
      expect(() => {
        BackendNamingConfigSchema.parse({
          terminology: { command: "action" },
        });
      }).toThrow();
    });
  });

  describe("Type enums", () => {
    test("FileCaseSchema accepts all valid values", () => {
      expect(FileCaseSchema.parse("kebab-case")).toBe("kebab-case");
      expect(FileCaseSchema.parse("camelCase")).toBe("camelCase");
      expect(FileCaseSchema.parse("snake_case")).toBe("snake_case");
      expect(FileCaseSchema.parse("PascalCase")).toBe("PascalCase");
    });

    test("SuffixStyleSchema accepts all valid values", () => {
      expect(SuffixStyleSchema.parse("dotted")).toBe("dotted");
      expect(SuffixStyleSchema.parse("suffixed")).toBe("suffixed");
      expect(SuffixStyleSchema.parse("worded")).toBe("worded");
    });

    test("EntityInclusionSchema accepts all valid values", () => {
      expect(EntityInclusionSchema.parse("always")).toBe("always");
      expect(EntityInclusionSchema.parse("never")).toBe("never");
      expect(EntityInclusionSchema.parse("flat-only")).toBe("flat-only");
    });
  });
});

describe("Validation helpers", () => {
  test("validateBackendNamingConfig returns validated config", () => {
    const result = validateBackendNamingConfig({ fileCase: "PascalCase" });
    expect(result.fileCase).toBe("PascalCase");
  });

  test("validateBackendNamingConfig throws on invalid input", () => {
    expect(() => {
      validateBackendNamingConfig({ fileCase: "invalid" });
    }).toThrow();
  });

  test("safeValidateBackendNamingConfig returns success for valid input", () => {
    const result = safeValidateBackendNamingConfig({ fileCase: "PascalCase" });
    expect(result.success).toBe(true);
    expect(result.data?.fileCase).toBe("PascalCase");
  });

  test("safeValidateBackendNamingConfig returns error for invalid input", () => {
    const result = safeValidateBackendNamingConfig({ fileCase: "invalid" });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("resolveLayerNaming", () => {
  test("returns global config when no layer override", () => {
    const config = BackendNamingConfigSchema.parse({
      fileCase: "kebab-case",
      suffixStyle: "dotted",
    });
    const result = resolveLayerNaming(config, "domain");
    expect(result.fileCase).toBe("kebab-case");
    expect(result.suffixStyle).toBe("dotted");
  });

  test("applies layer override when present", () => {
    const config = BackendNamingConfigSchema.parse({
      fileCase: "kebab-case",
      layers: {
        domain: { fileCase: "PascalCase" },
      },
    });
    const result = resolveLayerNaming(config, "domain");
    expect(result.fileCase).toBe("PascalCase");
    expect(result.suffixStyle).toBe("dotted"); // global default
  });

  test("merges partial layer override with global", () => {
    const config = BackendNamingConfigSchema.parse({
      fileCase: "snake_case",
      suffixStyle: "worded",
      entityInclusion: "always",
      layers: {
        application: { suffixStyle: "dotted" },
      },
    });
    const result = resolveLayerNaming(config, "application");
    expect(result.fileCase).toBe("snake_case"); // from global
    expect(result.suffixStyle).toBe("dotted"); // from layer
    expect(result.entityInclusion).toBe("always"); // from global
  });
});

// ============================================================================
// Case Converter Tests
// ============================================================================

describe("Case converters", () => {
  describe("toKebabCase", () => {
    test("converts snake_case", () => {
      expect(toKebabCase("deal_state")).toBe("deal-state");
    });
    test("converts PascalCase", () => {
      expect(toKebabCase("DealState")).toBe("deal-state");
    });
    test("converts camelCase", () => {
      expect(toKebabCase("dealState")).toBe("deal-state");
    });
    test("handles single word", () => {
      expect(toKebabCase("opportunity")).toBe("opportunity");
    });
  });

  describe("toSnakeCase", () => {
    test("converts kebab-case", () => {
      expect(toSnakeCase("deal-state")).toBe("deal_state");
    });
    test("converts PascalCase", () => {
      expect(toSnakeCase("DealState")).toBe("deal_state");
    });
    test("converts camelCase", () => {
      expect(toSnakeCase("dealState")).toBe("deal_state");
    });
  });

  describe("toCamelCase", () => {
    test("converts snake_case", () => {
      expect(toCamelCase("deal_state")).toBe("dealState");
    });
    test("converts kebab-case", () => {
      expect(toCamelCase("deal-state")).toBe("dealState");
    });
    test("converts PascalCase", () => {
      expect(toCamelCase("DealState")).toBe("dealState");
    });
  });

  describe("toPascalCase", () => {
    test("converts snake_case", () => {
      expect(toPascalCase("deal_state")).toBe("DealState");
    });
    test("converts kebab-case", () => {
      expect(toPascalCase("deal-state")).toBe("DealState");
    });
    test("converts camelCase", () => {
      expect(toPascalCase("dealState")).toBe("DealState");
    });
  });

  describe("applyCase", () => {
    test("applies kebab-case", () => {
      expect(applyCase("deal_state", "kebab-case")).toBe("deal-state");
    });
    test("applies snake_case", () => {
      expect(applyCase("deal-state", "snake_case")).toBe("deal_state");
    });
    test("applies camelCase", () => {
      expect(applyCase("deal_state", "camelCase")).toBe("dealState");
    });
    test("applies PascalCase", () => {
      expect(applyCase("deal_state", "PascalCase")).toBe("DealState");
    });
  });
});

// ============================================================================
// computeFileName Tests
// ============================================================================

describe("computeFileName", () => {
  describe("fileCase variations", () => {
    test("kebab-case with dotted suffix", () => {
      const config = {
        fileCase: "kebab-case" as const,
        suffixStyle: "dotted" as const,
        entityInclusion: "flat-only" as const,
        terminology: { command: "command" as const, query: "query" as const },
      };
      expect(computeFileName("deal_state", "entity", config, {})).toBe(
        "deal-state.entity.ts"
      );
    });

    test("PascalCase with suffixed style", () => {
      const config = {
        fileCase: "PascalCase" as const,
        suffixStyle: "suffixed" as const,
        entityInclusion: "flat-only" as const,
        terminology: { command: "command" as const, query: "query" as const },
      };
      expect(computeFileName("deal_state", "entity", config, {})).toBe(
        "DealStateEntity.ts"
      );
    });

    test("kebab-case with worded suffix", () => {
      const config = {
        fileCase: "kebab-case" as const,
        suffixStyle: "worded" as const,
        entityInclusion: "flat-only" as const,
        terminology: { command: "command" as const, query: "query" as const },
      };
      expect(computeFileName("deal_state", "entity", config, {})).toBe(
        "deal-state-entity.ts"
      );
    });

    test("snake_case with dotted suffix", () => {
      const config = {
        fileCase: "snake_case" as const,
        suffixStyle: "dotted" as const,
        entityInclusion: "flat-only" as const,
        terminology: { command: "command" as const, query: "query" as const },
      };
      expect(computeFileName("deal_state", "entity", config, {})).toBe(
        "deal_state.entity.ts"
      );
    });
  });

  describe("entityInclusion modes", () => {
    const baseConfig = {
      fileCase: "kebab-case" as const,
      suffixStyle: "dotted" as const,
      terminology: { command: "command" as const, query: "query" as const },
    };

    test("always includes entity name even when nested", () => {
      const config = { ...baseConfig, entityInclusion: "always" as const };
      expect(
        computeFileName("opportunity", "command", config, {
          action: "create",
          isNested: true,
        })
      ).toBe("create-opportunity.command.ts");
    });

    test("never includes entity name even when flat", () => {
      const config = { ...baseConfig, entityInclusion: "never" as const };
      expect(
        computeFileName("opportunity", "command", config, {
          action: "create",
          isNested: false,
        })
      ).toBe("create.command.ts");
    });

    test("flat-only includes entity name only when flat", () => {
      const config = { ...baseConfig, entityInclusion: "flat-only" as const };
      expect(
        computeFileName("opportunity", "command", config, {
          action: "create",
          isNested: true,
        })
      ).toBe("create.command.ts");
      expect(
        computeFileName("opportunity", "command", config, {
          action: "create",
          isNested: false,
        })
      ).toBe("create-opportunity.command.ts");
    });
  });

  describe("terminology support", () => {
    test("use-case terminology for commands", () => {
      const config = {
        fileCase: "kebab-case" as const,
        suffixStyle: "dotted" as const,
        entityInclusion: "flat-only" as const,
        terminology: { command: "use-case" as const, query: "query" as const },
      };
      expect(
        computeFileName("opportunity", "command", config, {
          action: "create",
          isNested: true,
        })
      ).toBe("create.use-case.ts");
    });

    test("use-case terminology for queries", () => {
      const config = {
        fileCase: "kebab-case" as const,
        suffixStyle: "dotted" as const,
        entityInclusion: "flat-only" as const,
        terminology: { command: "command" as const, query: "use-case" as const },
      };
      expect(
        computeFileName("opportunity", "query", config, {
          action: "get-by-id",
          isNested: true,
        })
      ).toBe("get-by-id.use-case.ts");
    });
  });

  describe("all file types", () => {
    const defaultConfig = DEFAULT_BACKEND_NAMING;

    const fileTypes = [
      "entity",
      "repositoryInterface",
      "repository",
      "command",
      "query",
      "dto",
      "controller",
      "module",
      "schema",
    ] as const;

    for (const fileType of fileTypes) {
      test(`handles ${fileType} correctly`, () => {
        const opts =
          fileType === "command" || fileType === "query"
            ? { action: "create" }
            : fileType === "controller" || fileType === "module"
            ? { plural: "opportunities" }
            : {};
        const result = computeFileName("opportunity", fileType, defaultConfig, opts);
        expect(result).toBeTruthy();
        expect(result).toMatch(/\.ts$/);
      });
    }
  });
});

// ============================================================================
// getEntityFileNames Tests
// ============================================================================

describe("getEntityFileNames", () => {
  test("returns expected file names with default config", () => {
    const files = getEntityFileNames({
      name: "opportunity",
      plural: "opportunities",
      isNested: true,
      isGrouped: false,
    });

    expect(files.entity).toBe("opportunity.entity.ts");
    expect(files.repository).toBe("opportunity.repository.ts");
    expect(files.createCommand).toBe("create.command.ts");
    expect(files.controller).toBe("opportunities.controller.ts");
  });

  test("includes entity name in flat mode", () => {
    const files = getEntityFileNames({
      name: "opportunity",
      plural: "opportunities",
      isNested: false,
      isGrouped: false,
    });

    expect(files.createCommand).toBe("create-opportunity.command.ts");
    expect(files.updateCommand).toBe("update-opportunity.command.ts");
    expect(files.deleteCommand).toBe("delete-opportunity.command.ts");
  });

  test("respects custom naming config", () => {
    const customConfig = {
      fileCase: "PascalCase" as const,
      suffixStyle: "suffixed" as const,
      entityInclusion: "always" as const,
      terminology: { command: "use-case" as const, query: "query" as const },
    };

    const files = getEntityFileNames({
      name: "opportunity",
      plural: "opportunities",
      isNested: true,
      isGrouped: false,
      namingConfig: customConfig,
    });

    expect(files.entity).toBe("OpportunityEntity.ts");
    expect(files.createCommand).toBe("CreateOpportunityUseCase.ts");
  });
});

// ============================================================================
// Backward Compatibility Tests
// ============================================================================

describe("Backward compatibility", () => {
  test("default config produces current hardcoded output", () => {
    const files = getEntityFileNames({
      name: "opportunity",
      plural: "opportunities",
      isNested: true,
      isGrouped: false,
    });

    // These must match the original hardcoded FILE_NAMING behavior
    expect(files.entity).toBe("opportunity.entity.ts");
    expect(files.repositoryInterface).toBe("opportunity.repository.interface.ts");
    expect(files.repository).toBe("opportunity.repository.ts");
    expect(files.createCommand).toBe("create.command.ts");
    expect(files.updateCommand).toBe("update.command.ts");
    expect(files.deleteCommand).toBe("delete.command.ts");
    expect(files.getByIdQuery).toBe("get-by-id.query.ts");
    expect(files.listQuery).toBe("list.query.ts");
    expect(files.dto).toBe("opportunity.dto.ts");
    expect(files.controller).toBe("opportunities.controller.ts");
    expect(files.module).toBe("opportunities.module.ts");
    expect(files.schema).toBe("opportunity.schema.ts");
  });

  test("multi-word entity names maintain current behavior", () => {
    const files = getEntityFileNames({
      name: "deal_state",
      plural: "deal_states",
      isNested: true,
      isGrouped: false,
    });

    expect(files.entity).toBe("deal-state.entity.ts");
    expect(files.schema).toBe("deal-state.schema.ts");
  });

  test("DEFAULT_BACKEND_NAMING matches expected defaults", () => {
    expect(DEFAULT_BACKEND_NAMING.fileCase).toBe("kebab-case");
    expect(DEFAULT_BACKEND_NAMING.suffixStyle).toBe("dotted");
    expect(DEFAULT_BACKEND_NAMING.entityInclusion).toBe("flat-only");
    expect(DEFAULT_BACKEND_NAMING.terminology.command).toBe("command");
    expect(DEFAULT_BACKEND_NAMING.terminology.query).toBe("query");
  });
});

// ============================================================================
// Custom Naming Configuration Tests
// ============================================================================

describe("Custom naming configurations", () => {
  describe("PascalCase + suffixed (C#/Java style)", () => {
    const config = {
      fileCase: "PascalCase" as const,
      suffixStyle: "suffixed" as const,
      entityInclusion: "always" as const,
      terminology: { command: "use-case" as const, query: "use-case" as const },
    };

    test("entity files use PascalCase with Entity suffix", () => {
      const files = getEntityFileNames({
        name: "opportunity",
        plural: "opportunities",
        isNested: true,
        namingConfig: config,
      });

      expect(files.entity).toBe("OpportunityEntity.ts");
      expect(files.repository).toBe("OpportunityRepository.ts");
      expect(files.dto).toBe("OpportunityDto.ts");
    });

    test("use-case terminology produces UseCase suffix", () => {
      const files = getEntityFileNames({
        name: "opportunity",
        plural: "opportunities",
        isNested: true,
        namingConfig: config,
      });

      expect(files.createCommand).toBe("CreateOpportunityUseCase.ts");
      expect(files.updateCommand).toBe("UpdateOpportunityUseCase.ts");
      expect(files.deleteCommand).toBe("DeleteOpportunityUseCase.ts");
    });

    test("queries also use UseCase suffix", () => {
      const files = getEntityFileNames({
        name: "opportunity",
        plural: "opportunities",
        isNested: true,
        namingConfig: config,
      });

      expect(files.getByIdQuery).toBe("GetByIdOpportunityUseCase.ts");
      expect(files.listQuery).toBe("ListOpportunitiesUseCase.ts");
    });
  });

  describe("kebab-case + worded (alternative style)", () => {
    const config = {
      fileCase: "kebab-case" as const,
      suffixStyle: "worded" as const,
      entityInclusion: "never" as const,
      terminology: { command: "command" as const, query: "query" as const },
    };

    test("entity files use kebab-case with worded suffix", () => {
      const files = getEntityFileNames({
        name: "deal_state",
        plural: "deal_states",
        isNested: false,
        namingConfig: config,
      });

      expect(files.entity).toBe("deal-state-entity.ts");
      expect(files.repository).toBe("deal-state-repository.ts");
    });

    test("never includes entity name even when flat", () => {
      const files = getEntityFileNames({
        name: "deal_state",
        plural: "deal_states",
        isNested: false,
        namingConfig: config,
      });

      expect(files.createCommand).toBe("create-command.ts");
      expect(files.updateCommand).toBe("update-command.ts");
    });
  });
});

// ============================================================================
// FILE_TYPE_SUFFIXES Tests
// ============================================================================

describe("FILE_TYPE_SUFFIXES", () => {
  test("has all required file types", () => {
    const expectedTypes = [
      "entity",
      "repositoryInterface",
      "repository",
      "command",
      "query",
      "dto",
      "controller",
      "module",
      "schema",
    ];

    for (const type of expectedTypes) {
      expect(FILE_TYPE_SUFFIXES[type]).toBeDefined();
      expect(FILE_TYPE_SUFFIXES[type].dotted).toBeDefined();
      expect(FILE_TYPE_SUFFIXES[type].suffixed).toBeDefined();
      expect(FILE_TYPE_SUFFIXES[type].word).toBeDefined();
    }
  });

  test("entity suffix patterns are correct", () => {
    expect(FILE_TYPE_SUFFIXES.entity.dotted).toBe(".entity");
    expect(FILE_TYPE_SUFFIXES.entity.suffixed).toBe("Entity");
    expect(FILE_TYPE_SUFFIXES.entity.word).toBe("entity");
  });

  test("repository suffix patterns are correct", () => {
    expect(FILE_TYPE_SUFFIXES.repository.dotted).toBe(".repository");
    expect(FILE_TYPE_SUFFIXES.repository.suffixed).toBe("Repository");
    expect(FILE_TYPE_SUFFIXES.repository.word).toBe("repository");
  });
});

// ============================================================================
// Integration Tests - YAML Config Loading
// ============================================================================

describe("YAML config loading integration", () => {
  test("loads and validates custom naming config from fixture", () => {
    const fixturePath = path.resolve(
      __dirname,
      "fixtures/codegen.config.custom-naming.yaml"
    );
    const content = fs.readFileSync(fixturePath, "utf-8");
    const parsed = yaml.parse(content);

    // Validate naming section against schema
    const result = BackendNamingConfigSchema.parse(parsed.naming);

    expect(result.fileCase).toBe("PascalCase");
    expect(result.suffixStyle).toBe("suffixed");
    expect(result.entityInclusion).toBe("always");
    expect(result.terminology.command).toBe("use-case");
    expect(result.terminology.query).toBe("use-case");
  });

  test("fixture config produces expected file names", () => {
    const fixturePath = path.resolve(
      __dirname,
      "fixtures/codegen.config.custom-naming.yaml"
    );
    const content = fs.readFileSync(fixturePath, "utf-8");
    const parsed = yaml.parse(content);

    const namingConfig = BackendNamingConfigSchema.parse(parsed.naming);

    const files = getEntityFileNames({
      name: "opportunity",
      plural: "opportunities",
      isNested: true,
      isGrouped: false,
      namingConfig,
    });

    // PascalCase + suffixed + always + use-case terminology
    expect(files.entity).toBe("OpportunityEntity.ts");
    expect(files.repository).toBe("OpportunityRepository.ts");
    expect(files.createCommand).toBe("CreateOpportunityUseCase.ts");
    expect(files.getByIdQuery).toBe("GetByIdOpportunityUseCase.ts");
  });
});
