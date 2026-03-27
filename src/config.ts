/**
 * Repo-local configuration system.
 *
 * Searches for config in this order:
 *   1. CLI-supplied --config <path>
 *   2. .backmerge.json
 *   3. .backmerge/config.json
 *   4. backmerge.config.json
 *
 * The engine works without config; config makes difficult repos better.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DocRoute {
  /** Glob patterns for commit-touched paths that trigger this doc */
  pathGlobs: string[];
  /** Keywords in commit message that trigger this doc */
  keywords?: string[];
  /** Doc files to include when triggered (globs relative to repo root) */
  docs: string[];
}

export interface BackmergeConfig {
  /** Default source ref (e.g. "origin/main") */
  sourceRef?: string;
  /** Default target ref (e.g. "origin/testnet") */
  targetRef?: string;
  /** Default persistent work branch name */
  workBranch?: string;

  /** Instruction files to always include in AI context */
  instructionFiles?: string[];
  /** Doc routing rules: map commit paths/keywords to relevant docs */
  docRoutes?: DocRoute[];
  /** Extra prompt hints appended to Codex analyze/apply prompts */
  promptHints?: string[];

  /** Path remap hints for when source/target have different directory structures */
  pathRemaps?: Array<{ source: string; target: string; note?: string }>;

  /** Review strictness: "strict" | "normal" | "lenient" */
  reviewStrictness?: "strict" | "normal" | "lenient";
  /** Max retries per commit */
  maxAttempts?: number;

  /** Commit message prefix (default: "backmerge:") */
  commitPrefix?: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const CONFIG_FILENAMES = [".backmerge.json", ".backmerge/config.json", "backmerge.config.json"];

const DEFAULT_CONFIG: BackmergeConfig = {
  instructionFiles: [],
  docRoutes: [],
  promptHints: [],
  pathRemaps: [],
  reviewStrictness: "normal",
  maxAttempts: undefined,
  commitPrefix: "backmerge:",
};

// ─── Loading ─────────────────────────────────────────────────────────────────

export function loadConfig(repoPath: string, explicitPath?: string): BackmergeConfig {
  const paths = explicitPath ? [explicitPath] : CONFIG_FILENAMES.map((f) => join(repoPath, f));

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = JSON.parse(raw) as Partial<BackmergeConfig>;
        return { ...DEFAULT_CONFIG, ...parsed };
      } catch (e) {
        throw new Error(`Failed to parse config at ${p}: ${(e as Error).message}`);
      }
    }
  }

  return { ...DEFAULT_CONFIG };
}

/** Check if a config file exists in the repo */
export function hasConfig(repoPath: string): boolean {
  return CONFIG_FILENAMES.some((f) => existsSync(join(repoPath, f)));
}
