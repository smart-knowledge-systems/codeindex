# AGENTS.md

Read `README.md` for what codeindex is and `SPEC.md` for how it is built; this file is only for directives. Think of these as good defaults: the developer's preferences override anything here. If a rule fights the task in front of you, say so loudly and get a human sign-off before breaking it.

Fight for the smallest model that makes the correct behavior unsurprising. Do not preserve complexity because it already exists, and do not add machinery because it looks impressive.

## The ways to hurt yourself

1. Killing by pattern. Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and the machine runs other dev servers and MCP servers. Kill only a PID you captured at spawn.
2. Writing to the live T3 install. `~/.t3/userdata` is the developer's real database, in use while you work. Reading and copying from it are fine. Never start a server against it, open it read-write, or clean it up.
3. Writing to the developer's real index. The primary checkout's `.codeindex.db`, `~/.config/codeindex/`, and the shared Postgres store are live data that other sessions search. Tests and experiments use a temporary repo root and a scratch database, never those.
4. Comparing with `git stash`. The stash stack is shared by every worktree of the clone, and another session can push or pop it while you work. Read the committed copy with `git show HEAD:<path>`, and set work aside in a WIP commit.
5. Pointing `core.hooksPath` anywhere. `cidx install-hook` writes `.git/hooks/post-commit`, and a hooks path silently turns that off.

## Tooling opinions

- `bun` installs packages, runs scripts, runs tests (`bun test`), and builds the binary. Never use `npm`, `npx`, `yarn`, or `pnpm`; use `bunx` for one-off tools.
- `oxlint` lints and `oxfmt` formats. `.oxlintrc.json` and `.oxfmtrc.json` are the whole configuration, and lint is type-aware through `oxlint-tsgolint`, so it only knows types for files `tsconfig.json` includes. Keep the `oxlint`, `oxfmt`, and `oxlint-tsgolint` versions pinned exactly and bump them together.
- Settings and ignores belong in `.oxlintrc.json` itself: oxlint's `extends` drops `settings` and `ignorePatterns` without a word.
- Keep types strict. Do not loosen `tsconfig.json` or turn off a lint rule to make a change pass; fix the change instead. When a rule is wrong for one line, suppress that line with its reason: `// oxlint-disable-next-line <rule> -- <why>`.
- `oxlint-tsgolint` reports a cast on an `any` value returned through a generic callback as unnecessary, and removing it breaks the typecheck. Run `bun run typecheck` after any `--fix`.
- Inferred types over annotations. `any` is the enemy: give SQL rows and parsed JSON real types at the boundary instead of passing `any` inward.
- Design types and data structures first, then the code that moves them.
- Every storage change has two backends. SQLite (`bun:sqlite` + `sqlite-vec`) and Postgres (Bun SQL) each get the change, the test, and a numbered migration in `migrations/` (`NNNN_name.sqlite.sql` and `NNNN_name.pg.sql`).
- Tree-sitter grammars are built here and committed under `grammars/wasm`; `docs/tree-sitter-grammars.md` says how to change one. Never point the loader at `node_modules`: compiled binaries embed the wasm and have no `node_modules`.

## Checks

- `bun run check` runs `oxfmt --check`, `oxlint --type-aware`, and `bun run typecheck`. Run it and `bun test` before pushing. CI runs the same steps on every PR.
- `bun run format` and `bun run lint:fix` apply fixes. Keep a formatter or autofix sweep in its own commit.
- Run checks in the foreground. If a run will exceed your tool's call limit, start it in the background and wait on it before ending your turn.

## Dogfood

This repo is codeindex, so use it on itself.

- Reach for `cidx search "<what the code does>"` first when you know what code does but not what it is called, then `Read` or `Grep` the paths it returns (scores above 0.5 are strong, 0.3–0.5 worth a look). Explore, Plan, and team agents use the CLI too.
- Reindex after commits (`cidx update --commit HEAD`, or install the hook with `cidx install-hook`). Never run a full `codeindex reindex` unasked, since indexing spends the developer's embedding budget.
- Keep `.claude/skills/codeindex/SKILL.md`, `codeindex.skill.md`, and `llm.txt` in sync: a CLI or MCP change that one of them describes updates all three in the same commit.
- After a schema change, migrate the repo's own `.codeindex.db` so the dogfood index keeps working.

## Worktrees

- T3 Code puts its worktrees under `~/.t3/worktrees/<project>/`. Work only in your own worktree and address it by absolute path. The primary checkout stays on `main`; agents never edit it.
- Scratch files go in the scratch directory your tool provides, never inside the worktree. Don't commit working material.
- Commit each finished piece at once, because a session can die mid-task and take uncommitted work with it.

## Comments

Good code explains itself. Make names, small functions and named constants carry what the code does, and rename until it reads without a comment. Keep a comment only for the why of a strongly opinionated decision, one a competent engineer would otherwise "fix" back and break: a security ordering, a pinned value, a platform quirk, a deliberate break from convention. Keep it to the reason, in a line or two. Don't narrate control flow, restate a name or type, add section banners, or leave commented-out code. Lint and compiler directives keep their reason text. This overrides matching the surrounding comment density: when you edit a heavily commented file, don't add to it, and you may trim the comments you find there to this standard.

## Self-contained wording

Code, comments, docs, commit messages and PR text describe the change on its own terms, for a reader who has only this repository. Don't cite chat sessions, agent names, review rounds, finding ids, scratch files or dates of decisions. That context belongs in the PR, never in code.

## Commit messages

- Before any git operation, run `gh auth switch --user smart-knowledge-systems`.
- Never commit directly to `main`.
- Subjects follow the repo's history: `type(area): summary`, lowercase imperative, no trailing period, for example `fix(dedup): scale countBlobsExcept past 65535-hash sets`. Types in use: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `style`, `build`, `chore`.
- Commit subjects are embedded as search vectors by codeindex, so they are search surface. Name the concrete thing (symbol, file, flag, command); a subject that means nothing without the diff is a subject nobody can retrieve.
- The body is prose wrapped at 72 columns: what was wrong, then what the change makes true, then what verified it. Skip it when the subject is the whole story.
- One commit, one concern. Agent-authored commits end with a `Co-Authored-By:` trailer naming the model.

## Markdown

Do not hard-wrap new prose in markdown files: one paragraph is one line. Commit message bodies are the exception. `oxfmt` formats markdown, including fenced code blocks inside it. Do not use **bold** text for list titles; use headings.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- Entry points. A behavior reachable from the CLI is usually reachable from an MCP tool too (`src/mcp/tools/`), and the reverse.
- Backends. SQLite and Postgres, local and cloud (`src/cloud/`), single repo and `--scope all`.
- Reverse states. If you added a way in, add the way out and the way to see it: an index command needs its `prune`, `status`, or `doctor` counterpart.
- Agent docs. `SKILL.md`, `codeindex.skill.md`, and `llm.txt` (see Dogfood).
- Docs. Check whether the change makes existing guidance inaccurate, then apply the rules under Documentation.

## Documentation

- Most code changes need no documentation change. Agents can read the code.
- `docs/` is for decisions and their reasons, constraints that span components, and traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it.
- Do not document every feature, enumerate fields or methods, narrate control flow, or append PR summaries. When a documented decision changes, rewrite or remove the text rather than appending.
- Documentation lands in the commit that changes the behavior it describes.

## PR workflow

- PRs live on GitHub (`smart-knowledge-systems/codeindex`). Never open one unless the developer asks; one request is one PR. Cut branches from `main`.
- Run `bun run check` and `bun test`, then push and open the PR. Do not bypass failed checks or disable their enforcement to land a change; fix the failure or get explicit developer authorization.
- One-way doors stay strict, because a revert can't undo them: migrations, the index schema, and anything that rewrites stored data. A destructive statement such as `DROP` is the developer's to run by hand. Stop and get the developer's approval.
- Report to the record: reasoning in the commit body, decisions and open questions in the PR body, review outcomes in PR comments.
- When babysitting a PR, watch it and end your turn; do not poll or sleep. Verify each review finding against the source before acting on it.

## Testing

- `bun test` runs `test/`. Specs use a temporary repo root and scratch databases, never a real index.
- Files under `test/fixtures/` are parser inputs compared byte for byte; lint and format skip them, and so should you.
- Fixtures taken from a real project, a private repository or someone's logs stay out of this repo. Write a synthetic fixture with the same shape.
- Never run tests from a git hook, `rebase --exec`, or `bisect run`, whose inherited `GIT_DIR` may point them at the real repository.

## Verification discipline

- A claim about a tool's or a dependency's behavior is only as good as the command that produced it. State the exact command and its output, or mark the claim `unverified, check before relying on it`.
- A `tsc` error count taken while any module fails to resolve is a lower bound, not a count. Confirm the tree resolves (no `TS2307`) before quoting a type-check count.

## Machine load

- Use the real git. On macOS, `/usr/bin/git` is an `xcrun` shim that costs about three times as much per call, so start shells with `export PATH="$(xcode-select -p)/usr/bin:$PATH"`.
- Stop a run by its process group, never by name: `kill -TERM -- -<pgid>`, then `kill -KILL -- -<pgid>` after a few seconds.

## Agent teams

Use agent teams for multi-file, cross-layer, or parallelizable work; `~/.claude/agent-teams.md` has setup and practices. A teammate edits only the files it was given, runs the checks on what it changed, and reports in five lines or fewer: branch, status, checks run, and one blocker line.
