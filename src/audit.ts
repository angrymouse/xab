/**
 * Enhanced logging & audit system.
 *
 * Creates a per-run directory structure:
 *   .backmerge/runs/<run-id>/
 *     results.jsonl          — machine-readable event log
 *     summary.json           — final summary
 *     commits/
 *       <hash>/
 *         source.patch       — original commit diff
 *         attempt-1/
 *           analysis.json
 *           applied.patch
 *           review-context.json
 *           review-result.json
 *           relevant-docs.txt
 */

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Decision, RunSummary } from "./decisions.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RunMetadata {
  runId: string;
  startedAt: string;
  sourceRef: string;
  targetRef: string;
  workBranch: string;
  mergeBase: string;
  worktreePath: string;
  totalCandidates: number;
  cherrySkipped: number;
  dryRun: boolean;
  repoPath: string;
}

export interface AuditEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}

// ─── Audit Logger ────────────────────────────────────────────────────────────

export class AuditLog {
  readonly runDir: string;
  readonly commitsDir: string;
  private resultsFile: string;

  constructor(baseDir: string, runId: string) {
    this.runDir = join(baseDir, ".backmerge", "runs", runId);
    this.commitsDir = join(this.runDir, "commits");
    this.resultsFile = join(this.runDir, "results.jsonl");
    mkdirSync(this.commitsDir, { recursive: true });
  }

  get resultsPath(): string {
    return this.resultsFile;
  }

  // ── JSONL event log ──────────────────────────────────────────────────

  emit(event: AuditEvent): void {
    appendFileSync(this.resultsFile, JSON.stringify(event) + "\n");
  }

  // ── Per-commit directory ─────────────────────────────────────────────

  commitDir(hash: string): string {
    const dir = join(this.commitsDir, hash.slice(0, 8));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  attemptDir(hash: string, attempt: number): string {
    const dir = join(this.commitDir(hash), `attempt-${attempt}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ── Write artifacts ──────────────────────────────────────────────────

  writeSourcePatch(hash: string, patch: string): string {
    const p = join(this.commitDir(hash), "source.patch");
    writeFileSync(p, patch);
    return p;
  }

  writeAnalysis(hash: string, attempt: number, analysis: Record<string, unknown>): string {
    const p = join(this.attemptDir(hash, attempt), "analysis.json");
    writeFileSync(p, JSON.stringify(analysis, null, 2));
    return p;
  }

  writeAppliedPatch(hash: string, attempt: number, patch: string): string {
    const p = join(this.attemptDir(hash, attempt), "applied.patch");
    writeFileSync(p, patch);
    return p;
  }

  writeReviewContext(hash: string, attempt: number, context: Record<string, unknown>): string {
    const p = join(this.attemptDir(hash, attempt), "review-context.json");
    writeFileSync(p, JSON.stringify(context, null, 2));
    return p;
  }

  writeReviewResult(hash: string, attempt: number, result: Record<string, unknown>): string {
    const p = join(this.attemptDir(hash, attempt), "review-result.json");
    writeFileSync(p, JSON.stringify(result, null, 2));
    return p;
  }

  writeRelevantDocs(hash: string, attempt: number, docs: string): string {
    const p = join(this.attemptDir(hash, attempt), "relevant-docs.txt");
    writeFileSync(p, docs);
    return p;
  }

  writeDiffStat(hash: string, attempt: number, stat: string): string {
    const p = join(this.attemptDir(hash, attempt), "target-diff.stat.txt");
    writeFileSync(p, stat);
    return p;
  }

  // ── Structured events ────────────────────────────────────────────────

  runStart(meta: RunMetadata): void {
    this.emit({ ts: new Date().toISOString(), event: "run_start", ...meta });
    writeFileSync(join(this.runDir, "metadata.json"), JSON.stringify(meta, null, 2));
  }

  runEnd(summary: RunSummary, decisions: Decision[]): void {
    this.emit({ ts: new Date().toISOString(), event: "run_end", summary });
    writeFileSync(join(this.runDir, "summary.json"), JSON.stringify({ summary, decisions }, null, 2));
  }

  commitStart(hash: string, message: string, index: number, total: number): void {
    this.emit({ ts: new Date().toISOString(), event: "commit_start", hash, message, index, total });
  }

  commitDecision(d: Decision): void {
    this.emit({ ts: new Date().toISOString(), event: "commit_decision", ...d });
  }

  cherrySkip(hash: string, message: string, reason: string): void {
    this.emit({ ts: new Date().toISOString(), event: "cherry_skip", hash, message, reason });
  }

  fetchReset(logs: string[]): void {
    this.emit({ ts: new Date().toISOString(), event: "fetch_reset", logs });
  }

  error(phase: string, hash: string, message: string, error: string): void {
    this.emit({ ts: new Date().toISOString(), event: "error", phase, hash, message, error });
  }

  // ── Progress state for resume ─────────────────────────────────────

  private get progressFile(): string {
    return join(this.runDir, "progress.json");
  }

  saveProgress(decisions: Decision[], commitIndex: number): void {
    writeFileSync(
      this.progressFile,
      JSON.stringify({ decisions, lastCommitIndex: commitIndex, savedAt: new Date().toISOString() }, null, 2),
    );
  }

  loadProgress(): { decisions: Decision[]; lastCommitIndex: number } | null {
    if (!existsSync(this.progressFile)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.progressFile, "utf-8"));
      return { decisions: raw.decisions ?? [], lastCommitIndex: raw.lastCommitIndex ?? -1 };
    } catch {
      return null;
    }
  }
}

// ─── Resume: find the latest run for a work branch ─────────────────────────

export interface ResumeInfo {
  runId: string;
  runDir: string;
  decisions: Decision[];
  lastCommitIndex: number;
}

/**
 * Find the most recent run with progress state for a given work branch.
 * Searches .backmerge/runs/ in the worktree base dir.
 */
export function findResumableRun(baseDir: string, workBranch: string): ResumeInfo | null {
  const runsDir = join(baseDir, ".backmerge", "runs");
  if (!existsSync(runsDir)) return null;

  const runDirs = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("run-"))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first

  for (const runId of runDirs) {
    const runDir = join(runsDir, runId);
    const metaFile = join(runDir, "metadata.json");
    const progressFile = join(runDir, "progress.json");
    const summaryFile = join(runDir, "summary.json");

    // Skip completed runs (have summary.json)
    if (existsSync(summaryFile)) continue;

    // Must have progress but no summary (interrupted)
    if (!existsSync(progressFile) || !existsSync(metaFile)) continue;

    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
      if (meta.workBranch !== workBranch) continue;

      const progress = JSON.parse(readFileSync(progressFile, "utf-8"));
      return {
        runId,
        runDir,
        decisions: progress.decisions ?? [],
        lastCommitIndex: progress.lastCommitIndex ?? -1,
      };
    } catch {
      continue;
    }
  }

  return null;
}
