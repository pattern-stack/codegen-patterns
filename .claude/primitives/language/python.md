# Python Language Primitive

Instructions for Python-specific workflows.

## File Patterns

- Source: `**/*.py`
- Tests: `**/test_*.py`, `**/*_test.py`
- Config: `pyproject.toml`, `setup.py`, `requirements.txt`

## Toolchain

| Tool | Command | Purpose |
|------|---------|---------|
| Format | `ruff format` | Code formatting |
| Lint | `ruff check` | Linting |
| Typecheck | `mypy` or `pyright` | Type checking |
| Test | `pytest` | Test runner |

## Conventions

- Use type hints for function signatures
- Prefer `pathlib.Path` over `os.path`
- Use `dataclasses` or `pydantic` for data structures
- Follow PEP 8 naming conventions

## Strategy Considerations

When planning Python implementations:
- Check for existing patterns (ORM models, API frameworks)
- Identify virtual environment and dependency management approach
- Note Python version constraints from `pyproject.toml`
