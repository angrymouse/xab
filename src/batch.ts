/**
 * Unattended batch runner — thin wrapper around the engine.
 *
 * JSONL output to stdout. Exit codes: 0=success, 1=fatal, 2=partial failure.
 */

import { runEngine, type EngineOptions, type EngineCallbacks } from "./engine.ts";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ...obj, ts: new Date().toISOString() }) + "\n");
}

export async function runBatch(opts: EngineOptions): Promise<number> {
  const cb: EngineCallbacks = {
    onLog(msg, color) {
      emit({ event: "log", msg, color });
    },
    onStatus(msg) {
      emit({ event: "status", msg });
    },
    onCommitStart(commit, index, total) {
      emit({ event: "commit_start", hash: commit.hash, message: commit.message, index, total });
    },
    onAnalysis(commit, analysis) {
      emit({ event: "analysis", hash: commit.hash, result: analysis });
    },
    onDecision(commit, decision) {
      emit({ event: "decision", hash: commit.hash, kind: decision.kind, reason: decision.reason });
    },
    onReview(commit, review) {
      emit({ event: "review", hash: commit.hash, approved: review.approved, issues: review.issues });
    },
  };

  try {
    const result = await runEngine(opts, cb);
    emit({
      event: "done",
      summary: result.summary,
      worktree: result.worktreePath,
      branch: result.workBranch,
      auditDir: result.auditDir,
      opsNotes: result.opsNotes,
    });

    const { summary } = result;
    if (summary.failed > 0) return 2;
    return 0;
  } catch (e) {
    emit({ event: "fatal", error: (e as Error).message });
    return 1;
  }
}
