# CLAUDE.md

## Required Behavior

- **Package manager:** Always use `bun` and `bunx` — never `npm`, `npx`, `yarn`, or `pnpm`
- **Git:** Never commit directly to main. Follow `docs/git-commit-style-guide.md` for commit conventions
- **GitHub account:** Run `gh auth switch --user smart-knowledge-systems` before git operations
- **Atomic commits**: One commit per logical change
- **Complex tasks:** Use agent teams for multi-file, cross-layer, or parallelizable work. See `~/.claude/agent-teams.md` for setup and best practices
- **Dogfood:** Keep .claude/skills/codeindex/SKILL.md in sync with codeindex.skill.md and migrate latest schema changes to .codeindex.db

## Commands

```bash
bun run check            # lint + typecheck combined
bun run format           # Prettier write
bun run lint:fix         # ESLint with auto-fix
```
