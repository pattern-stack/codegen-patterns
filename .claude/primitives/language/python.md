# Language: Python

Conventions, tooling, and default commands for Python projects.

## File Patterns

| Kind | Pattern |
|------|---------|
| Source | `**/*.py` |
| Tests | `**/test_*.py`, `**/*_test.py`, `tests/**/*.py` |
| Config | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt` |
| Lock | `poetry.lock`, `uv.lock`, `Pipfile.lock`, `requirements.txt` |

## Default Commands

Assumes a modern toolchain (`uv` or `poetry`, `ruff`, `pytest`, `mypy`). Override in `sdlc.yml` `commands:` when the project uses different tools.

| Gate | Default |
|------|---------|
| `typecheck` | `uv run mypy .` |
| `lint` | `uv run ruff check .` |
| `format_check` | `uv run ruff format --check .` |
| `format_fix` | `uv run ruff format .` |
| `test` | `uv run pytest` |
| `test_coverage` | `uv run pytest --cov` |
| `test_integration` | `uv run pytest tests/integration` |
| `build` | `uv build` |

For Poetry-based projects: replace `uv run` with `poetry run`, `uv build` with `poetry build`.

## Conventions

- Follow **PEP 8** (enforced by `ruff`)
- Use **type hints** on all public functions; `mypy --strict` for libraries
- Prefer **dataclasses** or **pydantic** models over plain dicts for structured data
- Explicit imports, no `from module import *`
- Virtual environments always — no global installs
- Use `pathlib.Path` over `os.path` for filesystem work

## Test Naming

```python
def test_<unit>_<behavior_under_condition>():
    ...

# e.g.
def test_parse_entity_raises_on_missing_name(): ...
def test_repository_returns_none_for_unknown_id(): ...
```

For pytest classes:

```python
class TestEntityRepository:
    def test_returns_none_for_unknown_id(self): ...
    def test_raises_on_duplicate_insert(self): ...
```

Test names describe observable behavior, not implementation.

## Strategy Considerations

- Identify the **framework** if any — see `framework/*` (FastAPI, Django, Flask)
- Identify the **async story** — `asyncio` vs sync; mixing is painful, follow project's existing pattern
- Identify the **packaging tool** (`uv`, `poetry`, `pip-tools`, `hatch`) — affects commands in `sdlc.yml`
- Check for **stub files** (`*.pyi`) for typed third-party code
- Check for a **src layout** (`src/package/...`) vs flat layout — affects imports and test discovery
