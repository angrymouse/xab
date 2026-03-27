/**
 * Strict per-commit decision model.
 *
 * Every commit processed by the engine must result in exactly one of these decisions.
 * Invariants are enforced by validateDecision().
 */

export type DecisionKind =
  | "applied" // Commit was applied and committed; exactly 1 new commit exists
  | "would_apply" // Dry-run: commit would be applied (no actual commit created)
  | "already_applied" // Commit is already present in target (patch-id or AI analysis)
  | "skip" // Explicitly skipped (user, config, or AI recommendation)
  | "failed"; // Apply/validation/review failed; HEAD was reset

export interface Decision {
  kind: DecisionKind;
  commitHash: string;
  commitMessage: string;
  /** How was this decided? */
  reason: string;
  /** New commit hash if applied */
  newCommitHash?: string;
  /** Files changed if applied */
  filesChanged?: string[];
  /** Review result if reviewed */
  reviewApproved?: boolean;
  reviewIssues?: string[];
  /** Error message if failed */
  error?: string;
  /** Which phase failed: analysis | apply | validation | review */
  failedPhase?: string;
  /** Operator action notes — env vars, migrations, infra changes needed */
  opsNotes?: string[];
  /** Duration of the full decision pipeline in ms */
  durationMs: number;
}

/**
 * Validate that a decision is internally consistent.
 * Throws if invariants are violated.
 */
export function validateDecision(d: Decision, headBefore: string, headAfter: string, isDryRun: boolean): string[] {
  const errors: string[] = [];
  const headMoved = headBefore !== headAfter;

  if (isDryRun) {
    // Dry-run must never create commits
    if (d.kind === "applied") {
      errors.push("Dry-run produced 'applied' decision — must use 'would_apply'");
    }
    if (headMoved) {
      errors.push(`Dry-run moved HEAD from ${headBefore.slice(0, 8)} to ${headAfter.slice(0, 8)}`);
    }
  }

  switch (d.kind) {
    case "applied":
      if (!headMoved) errors.push("Decision is 'applied' but HEAD did not move");
      if (!d.newCommitHash) errors.push("Decision is 'applied' but no newCommitHash");
      break;

    case "would_apply":
      if (headMoved) errors.push("Decision is 'would_apply' but HEAD moved");
      if (!isDryRun) errors.push("'would_apply' only valid in dry-run mode");
      break;

    case "already_applied":
    case "skip":
      if (headMoved) errors.push(`Decision is '${d.kind}' but HEAD moved`);
      break;

    case "failed":
      if (headMoved) errors.push("Decision is 'failed' but HEAD moved (should have been reset)");
      break;
  }

  return errors;
}

/** Summary counters for a run */
export interface RunSummary {
  applied: number;
  wouldApply: number;
  alreadyApplied: number;
  skipped: number;
  failed: number;
  total: number;
  cherrySkipped: number;
}

export function emptyRunSummary(): RunSummary {
  return { applied: 0, wouldApply: 0, alreadyApplied: 0, skipped: 0, failed: 0, total: 0, cherrySkipped: 0 };
}

export function updateSummary(s: RunSummary, d: Decision): void {
  switch (d.kind) {
    case "applied":
      s.applied++;
      break;
    case "would_apply":
      s.wouldApply++;
      break;
    case "already_applied":
      s.alreadyApplied++;
      break;
    case "skip":
      s.skipped++;
      break;
    case "failed":
      s.failed++;
      break;
  }
}
