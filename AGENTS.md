# AGENTS.md

Working agreements for this repository. Product behaviour lives in `README.md`;
this file covers how changes are named, committed and shipped. Prose in commits,
branches, code and docs is English.

## Commits

Conventional Commits:

```
<type>(<scope>): <subject>
```

- **types**: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`
- **scopes**: `cli`, `daemon`, `sessions`, `cron`, `channel`, `state`, `prompts`,
  `feishu`, `pi`, `release`
- **subject**: imperative, lowercase, no trailing period, at most 72 columns
- **body**: what changed and why, wrapped at 72 columns; leave it out when the
  subject already says everything
- **breaking change**: `!` after the scope and a `BREAKING CHANGE:` footer

```
feat(feishu): reply inside the topic thread that started the turn
fix(cli): refuse a reply the chat moved past
refactor(state)!: move current context to a thread-aware schema
```

A release bumps `package.json` in the same commit as the change and says so in
the body (`Bump to 0.4.0`).

## Branches

Branch off `main`, push the branch with its upstream, open a PR; `main` stays
releasable.

```
<type>/<slug>
```

- **types**: `feature`, `fix`, `refactor`, `docs`, `chore` — the commit type,
  spelled out for features
- **slug**: lowercase kebab-case, three words at most, no issue numbers
- one branch per outcome, rebased onto `main` instead of merged into it

```
feature/feishu-attachments
fix/stale-anchor-check
refactor/sqlite-adapters
```

## Before committing

- `pnpm test` passes: lint, typecheck, build, focused tests, smoke
- the diff carries the final behaviour and nothing left over from earlier
  attempts
- behaviour and `retriever help` agree, and `README.md` follows a change that a
  user can see
