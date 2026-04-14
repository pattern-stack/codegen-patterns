---
name: run-and-monitor
description: Start the codegen-patterns development environment and monitor application logs. Use when the user asks to start the app, check logs, debug backend issues, or monitor running services.
allowed-tools: Bash, Read, Grep, Glob
---

# Run & Monitor — Codegen Patterns Dev Environment

You are an agent responsible for running the codegen-patterns development environment and monitoring its state.

## Architecture Overview

Codegen-patterns is a CLI tool that generates NestJS scaffolding from YAML entity definitions. For testing generated output, it can scaffold and run a NestJS backend with Postgres.

**Application processes:**
| Process | Command | Purpose |
|---------|---------|---------|
| Code generation | `just gen entities/*.yaml` | Generate code from entity YAML |
| Unit tests | `just test-unit` | Fast unit tests (~200ms) |
| Baseline tests | `just test-baseline` | Snapshot comparison tests |
| Integration tests | `just test-integration` | Full Docker + codegen + NestJS |

**Docker services (for integration testing):**
| Service | Command | Purpose |
|---------|---------|---------|
| postgres | `just db-up` | PostgreSQL for scaffold testing |

## Starting the Environment

### Code generation (primary workflow)
```bash
just gen entities/opportunity.yaml    # Generate single entity
just gen-all                          # Generate all entities
just gen-subsystem events             # Scaffold a subsystem
```

### Testing
```bash
just test-unit                        # Unit tests (base classes + subsystems)
just test-baseline                    # Baseline snapshot test
just test-family                      # Family repo integration tests (needs Docker)
just test-integration                 # Full integration (Docker + codegen + NestJS)
just validate                         # End-to-end scaffold validation
```

### Database (scaffold testing only)
```bash
just db-up                            # Start Postgres
just db-push                          # Push schema
just db-down                          # Stop Postgres
```

## Checking Status

```bash
# Check if Docker services are running
docker compose ps 2>/dev/null || docker ps

# Check recent test results
just test-unit 2>&1 | tail -20

# Check for uncommitted work
git status
git diff --stat
```

## Domain Analysis

```bash
just validate-entities                # Validate YAML files
just analyze                          # Full analysis with graph
just stats                            # Statistics only
just scan                             # Auto-detect patterns, generate config
```

## Quality Gates

```bash
just test-unit                        # Fast unit tests
just test-baseline                    # Snapshot tests
just validate                         # Full validation
```

## Common Debugging

### Tests failing
1. Check YAML validity: `just validate-entities`
2. Run unit tests: `just test-unit`
3. Check baseline: `just test-baseline`

### Docker issues (integration tests)
1. Check Docker: `docker compose ps`
2. Start Postgres: `just db-up`
3. Push schema: `just db-push`

### Generated code issues
1. Check entity YAML is valid
2. Re-generate: `just gen entities/{name}.yaml`
3. Inspect output in the scaffold directory

## Key Files

| File | Purpose |
|------|---------|
| `justfile` | All task commands |
| `codegen.config.yaml` | Project configuration |
| `entities/*.yaml` | Entity definitions |
| `templates/` | Hygen EJS templates |
| `src/cli.ts` | CLI entry point |
| `test/` | Test fixtures and baselines |
