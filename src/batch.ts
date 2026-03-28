/**
 * Unattended batch runner with rich TTY output via chalk.
 *
 * Human-readable colored output to stderr (always visible).
 * JSONL to stdout when --jsonl flag is set (for piping).
 * Exit codes: 0=success, 1=fatal, 2=partial failure.
 */

import chalk from "chalk";
import { readFileSync } from "fs";
import { join } from "path";
import { runEngine, type EngineOptions, type EngineCallbacks, type EngineResult } from "./engine.ts";

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"));
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}
import type { CommitInfo } from "./git.ts";
import type { CommitAnalysis } from "./codex.ts";
import type { Decision } from "./decisions.ts";
import type { ReviewResult } from "./review.ts";

// ─── Formatting ──────────────────────────────────────────────────────────────

function shortHash(h: string): string {
  return h.slice(0, 8);
}

function ts(): string {
  return chalk.dim(new Date().toISOString().slice(11, 19));
}

function progressBar(current: number, total: number, width = 25): string {
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return `${chalk.green("█".repeat(filled))}${chalk.dim("░".repeat(empty))} ${current}/${total}`;
}

function divider(char = "─", width = 55): string {
  return chalk.dim(char.repeat(width));
}

const colorMap: Record<string, (s: string) => string> = {
  red: chalk.red,
  green: chalk.green,
  yellow: chalk.yellow,
  blue: chalk.blue,
  magenta: chalk.magenta,
  cyan: chalk.cyan,
  gray: chalk.gray,
  white: chalk.white,
};

function colorize(color: string | undefined, text: string): string {
  if (!color) return text;
  return (colorMap[color] ?? chalk.white)(text);
}

function decisionBadge(kind: Decision["kind"]): string {
  switch (kind) {
    case "applied":
      return chalk.bgGreen.black.bold(" APPLIED ");
    case "would_apply":
      return chalk.bgCyan.black.bold(" WOULD APPLY ");
    case "already_applied":
      return chalk.bgBlue.white.bold(" ALREADY APPLIED ");
    case "skip":
      return chalk.bgYellow.black.bold(" SKIP ");
    case "failed":
      return chalk.bgRed.white.bold(" FAILED ");
  }
}

function analysisBadge(status: "yes" | "no" | "partial"): string {
  switch (status) {
    case "yes":
      return chalk.green.bold("PRESENT");
    case "no":
      return chalk.red.bold("MISSING");
    case "partial":
      return chalk.yellow.bold("PARTIAL");
  }
}

// ─── Output channels ────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

function emitJsonl(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ...obj, ts: new Date().toISOString() }) + "\n");
}

// ─── Batch runner ────────────────────────────────────────────────────────────

export async function runBatch(opts: EngineOptions & { jsonl?: boolean }): Promise<number> {
  const jsonl = opts.jsonl ?? false;
  const startTime = Date.now();

  // ── Header ─────────────────────────────────────────────────────────
  const version = getVersion();
  log("");
  log(`  ${chalk.cyan.bold("xab")} ${chalk.dim(`v${version}`)} ${chalk.dim("— curated branch reconciliation")}`);
  log(`  ${chalk.magenta(opts.sourceRef)} ${chalk.dim("→")} ${chalk.green(opts.targetRef)}`);
  if (opts.workBranch) log(`  ${chalk.dim("work branch:")} ${chalk.cyan(opts.workBranch)}`);
  if (opts.dryRun) log(`  ${chalk.yellow.bold("DRY RUN")}`);
  log(`  ${divider()}`);
  log("");

  const cb: EngineCallbacks = {
    onProgress(phase, msg) {
      if (jsonl) emitJsonl({ event: "progress", phase, msg });
      const subMatch = msg.match(/^\[(\w+)\]\s*(.*)/);
      const sub = subMatch ? subMatch[1]! : phase;
      const text = subMatch ? subMatch[2]! : msg;

      // Only show icons for notable events, plain dim text for command output
      switch (sub) {
        case "file":
          log(`  ${ts()} ✏️  ${chalk.green(text)}`);
          break;
        case "think":
          log(`  ${ts()} 💭 ${chalk.blue(text)}`);
          break;
        case "read":
          log(`  ${ts()} 📖 ${chalk.dim(text)}`);
          break;
        default:
          log(`  ${ts()}    ${chalk.dim(text)}`);
          break;
      }
    },

    onLog(msg, color) {
      if (jsonl) emitJsonl({ event: "log", msg, color });
      if (!msg) {
        log("");
        return;
      }
      log(`  ${ts()} ${colorize(color, msg)}`);
    },

    onStatus(msg) {
      if (jsonl) emitJsonl({ event: "status", msg });
      log(`  ${ts()} ${chalk.dim("›")} ${msg}`);
    },

    onCommitStart(commit: CommitInfo, index: number, total: number) {
      if (jsonl) emitJsonl({ event: "commit_start", hash: commit.hash, message: commit.message, index, total });
      log("");
      log(`  ${divider()}`);
      log(`  ${progressBar(index + 1, total)}  ${chalk.yellow(shortHash(commit.hash))}`);
      log(`  ${chalk.bold(commit.message)}`);
      log(`  ${chalk.dim(`by ${commit.author} · ${commit.date}`)}`);
      log("");
    },

    onAnalysis(commit: CommitInfo, analysis: CommitAnalysis) {
      if (jsonl) emitJsonl({ event: "analysis", hash: commit.hash, result: analysis });
      log(`  ${ts()} ${chalk.dim("analysis:")} ${analysisBadge(analysis.alreadyInTarget)}`);
      log(`  ${chalk.dim("  summary:")} ${analysis.summary}`);
      if (analysis.reasoning) {
        log(`  ${chalk.dim("  reasoning:")} ${analysis.reasoning}`);
      }
      if (analysis.applicationStrategy && analysis.alreadyInTarget !== "yes") {
        log(`  ${chalk.dim("  strategy:")} ${analysis.applicationStrategy}`);
      }
      if (analysis.affectedComponents.length > 0) {
        log(`  ${chalk.dim("  components:")} ${analysis.affectedComponents.join(", ")}`);
      }
      if (analysis.opsNotes.length > 0) {
        log(`  ${chalk.yellow("  ops:")} ${analysis.opsNotes.join("; ")}`);
      }
    },

    onDecision(commit: CommitInfo, decision: Decision) {
      if (jsonl)
        emitJsonl({
          event: "decision",
          hash: commit.hash,
          kind: decision.kind,
          reason: decision.reason,
          opsNotes: decision.opsNotes,
        });
      const duration = chalk.dim(`${(decision.durationMs / 1000).toFixed(1)}s`);
      log(`  ${ts()} ${decisionBadge(decision.kind)} ${duration}`);
      if (decision.newCommitHash) {
        log(`  ${chalk.dim("  commit:")} ${decision.newCommitHash.slice(0, 8)}`);
      }
      if (decision.kind === "failed" && decision.error) {
        log(`  ${chalk.red(`  error: ${decision.error}`)}`);
      }
      if (decision.reason && decision.kind !== "failed") {
        log(`  ${chalk.dim("  reason:")} ${decision.reason}`);
      }
      if (decision.filesChanged && decision.filesChanged.length > 0) {
        for (const f of decision.filesChanged) {
          log(`  ${chalk.dim(`  · ${f}`)}`);
        }
      }
      if (decision.opsNotes && decision.opsNotes.length > 0) {
        for (const note of decision.opsNotes) {
          log(`  ${chalk.yellow(`  ops: ${note}`)}`);
        }
      }
    },

    onReview(commit: CommitInfo, review: ReviewResult) {
      if (jsonl) emitJsonl({ event: "review", hash: commit.hash, approved: review.approved, issues: review.issues });
      const badge = review.approved
        ? chalk.bgGreen.black.bold(" REVIEW OK ")
        : chalk.bgRed.white.bold(" REVIEW REJECTED ");
      log(`  ${ts()} ${badge} ${chalk.dim(`confidence: ${review.confidence}`)}`);
      if (!review.approved && review.issues.length > 0) {
        for (const issue of review.issues.slice(0, 3)) {
          log(`  ${chalk.red(`  · ${issue.slice(0, 120)}`)}`);
        }
        if (review.issues.length > 3) {
          log(`  ${chalk.dim(`  ...and ${review.issues.length - 3} more issues`)}`);
        }
      }
    },
  };

  // ── Run engine ─────────────────────────────────────────────────────
  let result: EngineResult;
  try {
    result = await runEngine(opts, cb);
  } catch (e) {
    if (jsonl) emitJsonl({ event: "fatal", error: (e as Error).message });
    log("");
    log(`  ${chalk.bgRed.white.bold(" FATAL ")} ${(e as Error).message}`);
    log("");
    return 1;
  }

  // ── Summary ────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const { summary } = result;

  log("");
  log(`  ${divider("═")}`);
  log(`  ${chalk.bold("Run complete")} ${chalk.dim(`in ${elapsed}s`)}`);
  log("");

  const counters = [
    summary.applied > 0 && `${chalk.green.bold(`${summary.applied}`)} applied`,
    summary.wouldApply > 0 && `${chalk.cyan.bold(`${summary.wouldApply}`)} would apply`,
    summary.alreadyApplied > 0 && `${chalk.blue.bold(`${summary.alreadyApplied}`)} already applied`,
    summary.skipped > 0 && `${chalk.yellow.bold(`${summary.skipped}`)} skipped`,
    summary.cherrySkipped > 0 && `${chalk.cyan(`${summary.cherrySkipped}`)} cherry-skipped`,
    summary.failed > 0 && `${chalk.red.bold(`${summary.failed}`)} failed`,
  ].filter(Boolean);

  log(`  ${counters.join(chalk.dim(" · "))}`);

  if (result.worktreePath) log(`  ${chalk.dim("worktree:")} ${result.worktreePath}`);
  if (result.workBranch) log(`  ${chalk.dim("branch:")}   ${result.workBranch}`);
  if (result.auditDir) log(`  ${chalk.dim("audit:")}    ${result.auditDir}`);

  // ── Ops notes ──────────────────────────────────────────────────────
  if (result.opsNotes.length > 0) {
    log("");
    log(`  ${chalk.yellow.bold("OPERATOR NOTES")}`);
    log(`  ${chalk.yellow(divider("─", 40))}`);
    for (const entry of result.opsNotes) {
      log(`  ${chalk.yellow(shortHash(entry.commitHash))} ${entry.commitMessage}`);
      for (const note of entry.notes) {
        log(`    ${chalk.yellow("→")} ${note}`);
      }
    }
  }

  // ── Failed commits ─────────────────────────────────────────────────
  const failed = result.decisions.filter((d) => d.kind === "failed");
  if (failed.length > 0) {
    log("");
    log(`  ${chalk.red.bold("FAILED COMMITS")}`);
    log(`  ${chalk.red(divider("─", 40))}`);
    for (const d of failed) {
      log(`  ${chalk.red(shortHash(d.commitHash))} ${d.commitMessage}`);
      log(`    ${chalk.dim("phase:")} ${d.failedPhase ?? "?"} ${chalk.dim("error:")} ${d.error?.slice(0, 100) ?? "?"}`);
    }
  }

  log(`  ${divider("═")}`);
  log("");

  if (jsonl) {
    emitJsonl({
      event: "done",
      summary: result.summary,
      worktree: result.worktreePath,
      branch: result.workBranch,
      auditDir: result.auditDir,
      opsNotes: result.opsNotes,
    });
  }

  if (summary.failed > 0) return 2;
  return 0;
}
