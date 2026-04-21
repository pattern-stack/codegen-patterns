# Language: Go

Conventions, tooling, and default commands for Go projects.

## File Patterns

| Kind | Pattern |
|------|---------|
| Source | `**/*.go` (excluding `*_test.go`) |
| Tests | `**/*_test.go` |
| Config | `go.mod`, `go.sum` |
| Tool config | `.golangci.yml`, `Makefile` |

## Default Commands

| Gate | Default |
|------|---------|
| `typecheck` | `go vet ./...` |
| `lint` | `golangci-lint run ./...` |
| `format_check` | `gofmt -l .` (fails if output is non-empty) |
| `format_fix` | `gofmt -w .` |
| `test` | `go test ./...` |
| `test_coverage` | `go test -cover ./...` |
| `test_integration` | `go test -tags=integration ./...` |
| `build` | `go build ./...` |

Go has no separate "typecheck" — compilation and `go vet` together serve that role.

## Conventions

- Follow **Effective Go** and the **Google Go Style Guide**
- Package names are **short, lowercase, single-word**
- Exported identifiers start with uppercase; unexported with lowercase
- Errors are **values** — return `error` explicitly; wrap with `fmt.Errorf("... %w", err)` for context
- Accept interfaces, return concrete types
- No `init()` functions unless unavoidable
- Keep package APIs small; internal types go in an `internal/` subtree

## Test Naming

```go
func TestEntityRepository_ReturnsNilForUnknownID(t *testing.T) { ... }
func TestParseEntity_RaisesOnMissingName(t *testing.T) { ... }
```

Table-driven tests for variations:

```go
func TestParser(t *testing.T) {
    cases := []struct {
        name    string
        input   string
        want    Entity
        wantErr bool
    }{
        {"valid entity", "...", Entity{...}, false},
        {"missing name", "...", Entity{}, true},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) { ... })
    }
}
```

Test names describe observable behavior. Subtest names (`t.Run`) describe the specific case.

## Strategy Considerations

- Identify **build tags** in use (`//go:build integration`) — affects which tests run in which gate
- Identify the **module layout** — monorepo with multiple `go.mod` files vs single module
- Identify **dependency management** — stick to `go mod`, avoid vendoring unless the project already vendors
- Check for **generated code** — `//go:generate` directives, `stringer`, protobuf — regenerate don't edit
- Identify the **target platforms** if cross-compiling (`GOOS`, `GOARCH` in build commands)
- Linters: `golangci-lint` is the de-facto meta-linter — check `.golangci.yml` for enabled rules before adding new ones
