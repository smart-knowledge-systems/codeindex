# CLAUDE.md

## Required Behavior

- **Package manager:** Always use `bun` and `bunx` — never `npm`, `npx`, `yarn`, or `pnpm`
- **Git:** Never commit directly to main. Follow `docs/git-commit-style-guide.md` for commit conventions
- **GitHub account:** Run `gh auth switch --user smart-knowledge-systems` before git operations
- **Atomic commits**: One commit per logical change
- **Complex tasks:** Use agent teams for multi-file, cross-layer, or parallelizable work. See `~/.claude/agent-teams.md` for setup and best practices
- **Dogfood:** 
  - use /codeindex as the primary/initial search (follow up with any tool, including standard grep)
  - Explore agents, Plan agents, and agentic teams should also utilize the `codeindex search` CLI
  - reindex after commits
  - Keep .claude/skills/codeindex/SKILL.md, codeindex.skill.md, and llm.txt in sync, and migrate latest schema changes to .codeindex.db

## Commands

```bash
bun run check            # lint + typecheck combined
bun run format           # Prettier write
bun run lint:fix         # ESLint with auto-fix
```
