# Freeform Commits Primitive

Instructions for freeform commit message style.

## Guidelines

No strict format required, but follow these principles:

### Good Commit Messages

- Start with imperative verb (Add, Fix, Update, Remove)
- Keep first line under 72 characters
- Explain what and why, not how

### Examples

```
Add user authentication via OAuth2

Fix crash when API returns null

Update dependencies to latest versions

Remove deprecated payment processor
```

## When to Use

- Personal projects
- Early prototyping
- Teams without commit conventions
- Repositories with mixed history

## Best Practices

Even without strict format:
- One logical change per commit
- Meaningful descriptions (not "fix stuff")
- Reference issues when relevant (`Fixes #123`)

## Strategy Implications

When planning commits:
- Focus on logical grouping
- Don't overthink format
- Prioritize clear descriptions
- Keep commits atomic but not tiny
