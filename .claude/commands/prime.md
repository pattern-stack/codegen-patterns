Load project context for this session.

Run these commands and internalize the results:

1. Read the root CLAUDE.md: `cat CLAUDE.md`
2. List all tracked files: `git ls-files`
3. Check current branch and recent commits: `git log --oneline -20`
4. Check for any uncommitted work: `git status`
5. Check for active work: look at GitHub issues via `gh issue list --state open`

## Skills & Commands Inventory

After loading project context, also catalog what's available:

6. List available skills: `ls .claude/skills/*/SKILL.md`
7. List available commands: `ls .claude/commands/*.md`
8. List available agents: `ls .claude/agents/*.md .claude/agents/team/*.md`

## Summary

After loading, provide a brief summary:
- Current branch and recent activity
- Any uncommitted changes
- Active issues
- Key architectural notes from CLAUDE.md
- Available skills, commands, and agents

Keep the summary to 10-15 lines. You are now primed and ready to work.
