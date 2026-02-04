# Strict Quality Profile

Maximum quality gates for production-critical code.

## Gates

All gates must pass before PR:

| Gate | Required | Blocking |
|------|----------|----------|
| Format | ✓ | Yes |
| Lint | ✓ | Yes |
| Typecheck | ✓ | Yes |
| Test | ✓ | Yes |
| Coverage | ✓ (80%+) | Yes |
| Security | ✓ | Yes |

## Testing Requirements

- Unit tests for all new functions
- Integration tests for API endpoints
- Edge cases explicitly tested
- Error paths covered

## Coverage Thresholds

```yaml
coverage:
  global: 80%
  new_code: 90%
  critical_paths: 95%
```

## When to Use

- Production services
- Shared libraries
- Security-sensitive code
- Financial/compliance systems

## Strategy Implications

When planning with strict quality:
- Budget time for comprehensive tests
- Identify existing test patterns to follow
- Plan for security review of sensitive changes
- Consider backward compatibility
