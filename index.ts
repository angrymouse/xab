#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { resolve } from "path";
import App from "./src/app.tsx";
import type { EngineOptions } from "./src/engine.ts";

const args = process.argv.slice(2);

// Parse flags
let repoPath = ".";
let sourceRef = "";
let targetRef = "";
let workBranch = "";
let resetWorkBranch = false;
let dryRun = false;
let listOnly = false;
let doFetch = false;
let review = true;
let autoSkip = true;
let maxAttempts = 2;
let startAfter = "";
let limit = 0;
let configPath = "";
let batch = false;
let jsonl = false;
let resume = true; // resume by default
let showHelp = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--help" || arg === "-h") showHelp = true;
  else if (arg === "--batch" || arg === "-b") batch = true;
  else if (arg === "--jsonl") {
    batch = true;
    jsonl = true;
  } else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--list-only") listOnly = true;
  else if (arg === "--fetch" || arg === "-f") doFetch = true;
  else if (arg === "--no-fetch") doFetch = false;
  else if (arg === "--no-review") review = false;
  else if (arg === "--no-auto-skip") autoSkip = false;
  else if (arg === "--reset-work-branch") {
    resetWorkBranch = true;
    resume = false;
  } else if (arg === "--no-resume") resume = false;
  else if (arg === "--source-ref" && args[i + 1]) sourceRef = args[++i]!;
  else if (arg === "--target-ref" && args[i + 1]) targetRef = args[++i]!;
  else if (arg === "--work-branch" && args[i + 1]) workBranch = args[++i]!;
  else if (arg === "--start-after" && args[i + 1]) startAfter = args[++i]!;
  else if (arg === "--limit" && args[i + 1]) limit = parseInt(args[++i]!, 10) || 0;
  else if (arg === "--max-attempts" && args[i + 1]) maxAttempts = parseInt(args[++i]!, 10) || 2;
  else if (arg === "--config" && args[i + 1]) configPath = args[++i]!;
  else if (!arg.startsWith("-")) repoPath = arg;
}

if (showHelp) {
  console.log(`
xab — AI-powered curated branch reconciliation

Usage:
  xab [repo-path] [options]

Ref selection:
  --source-ref <ref>      Source branch/ref (where changes come FROM)
  --target-ref <ref>      Target branch/ref (where changes merge INTO)
  --work-branch <name>    Persistent work branch (resumes if exists)
  --reset-work-branch     Force-reset work branch to target ref

Modes:
  --batch, -b             Unattended batch mode (JSONL to stdout)
  --dry-run               Analyze only, never create commits
  --list-only             List candidate commits and exit

Filtering:
  --start-after <sha>     Skip commits up to and including this hash
  --limit <n>             Process at most n commits

Behavior:
  --fetch, -f             Fetch remotes before starting
  --no-fetch              Skip fetch (default)
  --no-review             Skip Claude review pass
  --no-auto-skip          Don't auto-skip commits AI identifies as present
  --max-attempts <n>      Max retries per commit (default: 2)
  --no-resume             Don't resume from interrupted runs (default: auto-resume)
  --config <path>         Path to config file (default: auto-discover)
  --help, -h              Show this help

Config:
  Place .xab.json in the target repo for persistent settings:
  - sourceRef, targetRef, workBranch: default refs
  - instructionFiles: extra docs to include in AI context
  - docRoutes: map commit paths/keywords to relevant docs
  - promptHints: extra instructions for AI
  - pathRemaps: source→target path mappings
  - reviewStrictness: "strict" | "normal" | "lenient"
  - maxAttempts, commitPrefix

Pipeline:
  1. Discover repo structure, instruction files, docs
  2. Resolve refs, compute merge base
  3. Detect already cherry-picked commits (git patch-id)
  4. For each remaining commit:
     a. Build per-commit context (relevant docs, repo hints)
     b. Codex (gpt-5.4, high) analyzes: present/missing/partial
     c. Auto-skip if already present
     d. Codex applies changes (curated merge, not cherry-pick)
     e. Validate: exactly 1 clean commit, no conflict markers
     f. Claude (opus 4.6, high) reviews applied diff
     g. Branch advances only after review approval
  5. Audit log + artifacts written to .xab/runs/

Models:
  - Analysis/Apply: gpt-5.4 (high reasoning effort) via Codex SDK
  - Review: claude-opus-4-6 (high reasoning effort) via Claude Agent SDK

Exit codes (batch): 0=success, 1=fatal, 2=partial failure

Prerequisites:
  - codex CLI: npm install -g @openai/codex
  - Claude Code CLI: npm install -g @anthropic-ai/claude-code
`);
  process.exit(0);
}

const resolvedPath = resolve(repoPath);

// ── Load config defaults for refs when CLI flags aren't provided ─────────
import { loadConfig } from "./src/config.ts";
const repoConfig = loadConfig(resolvedPath, configPath || undefined);
if (!sourceRef && repoConfig.sourceRef) sourceRef = repoConfig.sourceRef;
if (!targetRef && repoConfig.targetRef) targetRef = repoConfig.targetRef;
if (!workBranch && repoConfig.workBranch) workBranch = repoConfig.workBranch;
if (repoConfig.maxAttempts && maxAttempts === 2) maxAttempts = repoConfig.maxAttempts;

const engineOpts: Partial<EngineOptions> = {
  ...(sourceRef && { sourceRef }),
  ...(targetRef && { targetRef }),
  ...(workBranch && { workBranch }),
  ...(resetWorkBranch && { resetWorkBranch }),
  ...(dryRun && { dryRun }),
  ...(listOnly && { listOnly }),
  ...(doFetch && { fetch: doFetch }),
  review,
  autoSkip,
  resume,
  maxAttempts,
  ...(startAfter && { startAfter }),
  ...(limit > 0 && { limit }),
  ...(configPath && { configPath }),
};

if (batch || listOnly) {
  if (!sourceRef || !targetRef) {
    console.error("Error: --batch/--list-only requires --source-ref and --target-ref (via flags or .xab.json)");
    process.exit(1);
  }
  const { runBatch } = await import("./src/batch.ts");
  const exitCode = await runBatch({
    repoPath: resolvedPath,
    sourceRef,
    targetRef,
    ...engineOpts,
    jsonl,
  } as EngineOptions);
  process.exit(exitCode);
} else {
  console.clear();
  const { waitUntilExit } = render(React.createElement(App, { repoPath: resolvedPath, engineOpts }));
  await waitUntilExit();
}
