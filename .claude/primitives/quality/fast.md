# Fast Quality Profile

Minimal quality gates for rapid iteration.

## Gates

Essential gates only:

| Gate | Required | Blocking |
|------|----------|----------|
| Format | ✓ | Yes |
| Lint | ✓ | Yes |
| Typecheck | Optional | No |
| Test | Optional | No |
| Coverage | No | No |
| Security | No | No |

## Testing Requirements

- Tests for complex logic only
- Happy path coverage sufficient
- Integration tests optional

## When to Use

- Prototypes and experiments
- Internal tools
- Documentation changes
- Spike/research branches
- Early development phases

## Strategy Implications

When planning with fast quality:
- Focus on core functionality first
- Skip edge case handling initially
- Defer comprehensive testing
- Mark technical debt for later

## Upgrade Path

When code stabilizes, upgrade to `strict`:
1. Add missing tests
2. Enable typecheck gate
3. Add coverage requirements
4. Run security scan
