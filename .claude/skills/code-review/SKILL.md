---
name: code-review
description: Review code for quality, security, performance, and maintainability. Use when asked to review, audit, or analyze code changes, PRs, or files.
allowed-tools: Read, Grep, Glob, Bash(git:*)
user-invocable: true
hooks:
  PostToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: "./scripts/log-review.sh"
          once: true
---

# Code Review Skill

Comprehensive code review following team standards.

## Review Process

1. **Understand Context**: Read the files, check git history if relevant
2. **Security Scan**: Check for OWASP Top 10 vulnerabilities
3. **Performance Review**: Identify bottlenecks, N+1 queries, memory leaks
4. **Maintainability**: Assess readability, complexity, test coverage
5. **Standards Compliance**: Verify against team coding standards

## Output Format

Provide findings in priority order:

```markdown
## 🔴 Critical
[Security vulnerabilities, data loss risks]

## 🟠 High
[Performance issues, logic errors]

## 🟡 Medium
[Code smells, maintainability concerns]

## 🟢 Suggestions
[Style improvements, nice-to-haves]
```

## Checklists

See [cookbook/security.md](cookbook/security.md) for security checklist.
See [cookbook/performance.md](cookbook/performance.md) for performance patterns.

## When to Escalate

- Credential exposure → Immediate notification
- Data loss risk → Block merge, require senior review
- Architectural concerns → Flag for team discussion
