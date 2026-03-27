# backmerge

AI-powered curated branch reconciliation engine. Merges the _intent_ of source branch commits into a target branch that may have diverged significantly — not a blind cherry-pick.

## Prerequisites

```bash
npm install -g @openai/codex        # Codex CLI (gpt-5.4 for analysis/apply)
npm install -g @anthropic-ai/claude-code  # Claude Code (opus 4.6 for review)
bun install                          # Project deps
```

## Quick start

```bash
# Interactive TUI — select branches interactively
bun run index.ts /path/to/repo

# With explicit refs
bun run index.ts /path/to/repo --source-ref origin/main --target-ref origin/testnet

# Persistent work branch (resumes if exists)
bun run index.ts /path/to/repo \
  --source-ref origin/main \
  --target-ref origin/testnet \
  --work-branch merged-testnet

# Dry-run — analyze only, no commits
bun run index.ts /path/to/repo \
  --source-ref origin/main --target-ref origin/testnet --dry-run --batch

# List candidates only
bun run index.ts /path/to/repo \
  --source-ref origin/main --target-ref origin/testnet --list-only

# Batch mode — unattended, JSONL output
bun run index.ts /path/to/repo --batch \
  --source-ref origin/main --target-ref origin/testnet \
  --work-branch merged-testnet --fetch
```

## Pipeline

For each source commit since the merge base:

1. **Cherry-pick detection** — `git cherry` / patch-id comparison skips already-picked commits
2. **Repo context** — discovers AGENTS.md, CLAUDE.md, ai-docs/\*, and routes relevant docs per commit
3. **Analysis** (Codex, gpt-5.4 high) — determines if the commit is already present, partial, or missing
4. **Auto-skip** — commits already in target are skipped by default
5. **Apply** (Codex, gpt-5.4 high) — curated merge: adapts intent to target architecture
6. **Validate** — exactly 1 new commit, clean worktree, no conflict markers
7. **Review** (Claude, opus 4.6 high) — full code review of applied diff with repo context
8. **Advance** — branch only moves forward after review approval

## Decision model

Every commit results in exactly one decision:

| Decision          | Meaning                          | HEAD moves?     |
| ----------------- | -------------------------------- | --------------- |
| `applied`         | Applied and committed            | Yes (+1 commit) |
| `would_apply`     | Dry-run: would be applied        | No              |
| `already_applied` | Already present (patch-id or AI) | No              |
| `skip`            | User/config skipped              | No              |
| `failed`          | Apply/validation/review failed   | No (reset)      |

## Repo-local configuration

Place `.backmerge.json` in the target repo root:

```json
{
  "sourceRef": "origin/main",
  "targetRef": "origin/testnet",
  "workBranch": "merged-testnet",
  "instructionFiles": ["AGENTS.md", "CLAUDE.md"],
  "docRoutes": [
    {
      "pathGlobs": ["frontend/**"],
      "keywords": ["frontend", "ui", "nuxt", "vue"],
      "docs": ["ai-docs/frontend.md"]
    },
    {
      "pathGlobs": ["matching-engine/**"],
      "keywords": ["engine", "matcher", "orderbook"],
      "docs": ["ai-docs/matching-engine.md"]
    },
    {
      "pathGlobs": ["api/**"],
      "docs": ["ai-docs/scripts.md", "ai-docs/fiat-ramp.md"]
    },
    {
      "pathGlobs": ["contracts/**"],
      "docs": ["ai-docs/fast-markets.md"]
    }
  ],
  "promptHints": [
    "This is a prediction market platform on Base Mainnet",
    "frontend uses pt-BR locale, preserve Portuguese text",
    "contracts/lib/ is vendored — do not modify"
  ],
  "reviewStrictness": "normal",
  "maxAttempts": 2,
  "commitPrefix": "backmerge:"
}
```

The engine auto-discovers AGENTS.md, CLAUDE.md, ai-docs/\*, and docs/\* without config. Config adds precision for difficult repos.

## CLI flags

```
Ref selection:
  --source-ref <ref>      Source branch/ref
  --target-ref <ref>      Target branch/ref
  --work-branch <name>    Persistent work branch
  --reset-work-branch     Force-reset work branch to target

Modes:
  --batch, -b             Unattended JSONL mode
  --dry-run               Analyze only
  --list-only             List commits and exit

Filtering:
  --start-after <sha>     Skip commits up to this hash
  --limit <n>             Process at most n commits

Behavior:
  --fetch, -f             Fetch remotes first
  --no-review             Skip Claude review
  --no-auto-skip          Ask about every commit
  --max-attempts <n>      Retries per commit (default: 2)
  --config <path>         Config file path
```

## Audit & artifacts

Each run creates:

```
.backmerge/runs/<run-id>/
  metadata.json           # Run parameters
  results.jsonl           # Machine-readable event log
  summary.json            # Final summary + all decisions
  commits/
    <hash>/
      source.patch        # Original commit diff
      attempt-1/
        analysis.json     # Codex analysis result
        applied.patch     # What was committed
        review-context.json
        review-result.json
        relevant-docs.txt
        target-diff.stat.txt
```

## Persistent work branch

With `--work-branch`, the engine:

- Creates the branch from `--target-ref` if it doesn't exist
- Resumes from it if it already exists
- Use `--reset-work-branch` to force-reset to target

This supports iterative curated merges over time.

## Exit codes (batch)

- `0` — all commits processed successfully
- `1` — fatal error (bad refs, missing CLI, etc.)
- `2` — some commits failed or were review-rejected

## Architecture

```
src/
  config.ts       Repo-local config (.backmerge.json)
  context.ts      Repo intelligence: doc discovery, per-commit context
  decisions.ts    Strict decision model with validation
  engine.ts       Core pipeline (used by both frontends)
  codex.ts        Codex SDK: analyze + apply (gpt-5.4)
  review.ts       Claude review: packets + execution (opus 4.6)
  audit.ts        Per-run logging + artifact storage
  git.ts          Git operations: worktree, cherry-pick, validation
  app.tsx          Interactive TUI (ink/React)
  batch.ts        Unattended batch runner
index.ts          CLI entry point
```

## Adapting to a new repo

1. Run `backmerge /path/to/repo` — it works without config
2. If merges need tuning, add `.backmerge.json` with doc routes and prompt hints
3. No engine code changes needed — everything is config-driven
