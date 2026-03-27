/**
 * Core merge engine.
 *
 * Stateless pipeline: given refs, config, and callbacks, processes commits.
 * Used by both TUI (interactive) and batch (unattended) frontends.
 */

import type { SimpleGit } from "simple-git";
import type { BackmergeConfig } from "./config.ts";
import type { RepoContext, CommitContext } from "./context.ts";
import type { Decision, RunSummary } from "./decisions.ts";
import type { CommitAnalysis, ApplyResult } from "./codex.ts";
import type { ReviewResult, ReviewPacket } from "./review.ts";
import type { AuditLog, RunMetadata } from "./audit.ts";
import type { CommitInfo } from "./git.ts";

import { loadConfig } from "./config.ts";
import { buildRepoContext, buildCommitContext } from "./context.ts";
import { emptyRunSummary, updateSummary, validateDecision } from "./decisions.ts";
import { analyzeCommit, applyCommit, fixFromReview, checkCodexInstalled } from "./codex.ts";
import { reviewAppliedDiff, writeReviewPacket, verifyReviewIntegrity } from "./review.ts";
import { AuditLog as AuditLogClass, findResumableRun } from "./audit.ts";
import {
  createGit,
  isGitRepo,
  resolveRef,
  getHead,
  getBranches,
  getMergeBase,
  getCommitsSince,
  getCommitDiff,
  getCommitDiffStat,
  getCommitFiles,
  getLatestCommitDiff,
  getDescendantCommitsSince,
  generateWorktreePath,
  createWorktree,
  createDetachedWorktree,
  ensureWorkBranch,
  advanceBranch,
  findAlreadyCherryPicked,
  validateApply,
  getAppliedDiff,
  getAppliedDiffStat,
  resetHard,
  fetchAndReset,
} from "./git.ts";

// ─── Engine options ──────────────────────────────────────────────────────────

export interface EngineOptions {
  repoPath: string;
  sourceRef: string;
  targetRef: string;
  workBranch?: string;
  resetWorkBranch?: boolean;
  dryRun?: boolean;
  listOnly?: boolean;
  fetch?: boolean;
  review?: boolean;
  autoSkip?: boolean;
  maxAttempts?: number;
  startAfter?: string;
  limit?: number;
  configPath?: string;
  /** Resume from the last interrupted run (auto-detected from work branch) */
  resume?: boolean;
}

/** Callback interface for frontends to receive progress events */
export interface EngineCallbacks {
  onLog(msg: string, color?: string): void;
  onStatus(msg: string): void;
  onCommitStart(commit: CommitInfo, index: number, total: number): void;
  onAnalysis(commit: CommitInfo, analysis: CommitAnalysis): void;
  onDecision(commit: CommitInfo, decision: Decision): void;
  onReview?(commit: CommitInfo, review: ReviewResult): void;
  /** Return false to skip, true to apply. Only called in interactive mode. */
  onAskApply?(commit: CommitInfo, analysis: CommitAnalysis): Promise<"apply" | "skip" | "quit">;
  /** Called when review rejects. Return "retry" | "skip" | "quit" */
  onReviewRejected?(commit: CommitInfo, review: ReviewResult): Promise<"retry" | "skip" | "quit">;
}

export interface EngineResult {
  summary: RunSummary;
  decisions: Decision[];
  worktreePath: string;
  workBranch: string;
  auditDir: string;
  commits: CommitInfo[];
  /** Aggregated operator notes from all applied/would_apply commits */
  opsNotes: Array<{ commitHash: string; commitMessage: string; notes: string[] }>;
}

// ─── Main engine ─────────────────────────────────────────────────────────────

export async function runEngine(opts: EngineOptions, cb: EngineCallbacks): Promise<EngineResult> {
  const {
    repoPath,
    sourceRef,
    targetRef,
    dryRun = false,
    listOnly = false,
    fetch = false,
    review = true,
    autoSkip = true,
  } = opts;

  // ── Config & context ─────────────────────────────────────────────────
  const config = loadConfig(repoPath, opts.configPath);
  const effectiveMaxAttempts = opts.maxAttempts ?? config.maxAttempts ?? 2;
  const effectiveWorkBranch = opts.workBranch ?? config.workBranch;
  const commitPrefix = config.commitPrefix ?? "backmerge:";

  // ── Preflight ────────────────────────────────────────────────────────
  if (!checkCodexInstalled()) throw new Error("codex CLI not found. Install: npm install -g @openai/codex");

  const git = createGit(repoPath);
  if (!(await isGitRepo(git))) throw new Error(`${repoPath} is not a git repository`);

  cb.onLog("codex CLI found", "green");

  // ── Fetch ────────────────────────────────────────────────────────────
  if (fetch) {
    cb.onStatus("Fetching remotes...");
    const logs = await fetchAndReset(git, []);
    for (const l of logs) cb.onLog(`  ${l}`, "gray");
  }

  // ── Repo context ─────────────────────────────────────────────────────
  cb.onStatus("Discovering repo structure & docs...");
  const repoCtx = buildRepoContext(repoPath, config);
  const instrCount = repoCtx.instructions.size;
  const docCount = repoCtx.docPaths.length;
  cb.onLog(`Repo: ${repoCtx.structure.type}, ${instrCount} instruction files, ${docCount} doc files`, "gray");
  if (instrCount > 0) {
    cb.onLog(`  Instructions: ${[...repoCtx.instructions.keys()].join(", ")}`, "gray");
  }

  // ── Resolve refs ─────────────────────────────────────────────────────
  cb.onStatus("Resolving refs...");
  const resolvedSource = await resolveRef(git, sourceRef);
  const resolvedTarget = await resolveRef(git, targetRef);
  cb.onLog(`Source: ${sourceRef} → ${resolvedSource.slice(0, 8)}`, "gray");
  cb.onLog(`Target: ${targetRef} → ${resolvedTarget.slice(0, 8)}`, "gray");

  const mergeBase = await getMergeBase(git, resolvedTarget, resolvedSource);
  cb.onLog(`Merge base: ${mergeBase.slice(0, 8)}`, "gray");

  // ── Commits ──────────────────────────────────────────────────────────
  const allSourceCommits = await getCommitsSince(git, mergeBase, resolvedSource);
  const targetCommits = await getDescendantCommitsSince(git, mergeBase, resolvedTarget);
  cb.onLog(
    `${allSourceCommits.length} source commits, ${targetCommits.length} target commits since divergence`,
    "blue",
  );

  if (allSourceCommits.length === 0) {
    cb.onLog("No source commits to process!", "green");
    return {
      summary: emptyRunSummary(),
      decisions: [],
      worktreePath: "",
      workBranch: "",
      auditDir: "",
      commits: [],
      opsNotes: [],
    };
  }

  // ── Cherry-pick detection ────────────────────────────────────────────
  cb.onStatus("Detecting already cherry-picked commits...");
  const { needed, skipped: cherrySkipped } = await findAlreadyCherryPicked(
    git,
    resolvedTarget,
    resolvedSource,
    mergeBase,
  );

  const summary = emptyRunSummary();
  const decisions: Decision[] = [];
  summary.cherrySkipped = cherrySkipped.size;

  let commitsToProcess = allSourceCommits.filter((c) => needed.has(c.hash));
  cb.onLog(`${cherrySkipped.size} cherry-picked (skipped), ${commitsToProcess.length} to process`, "blue");

  // ── --start-after filter ─────────────────────────────────────────────
  if (opts.startAfter) {
    const idx = commitsToProcess.findIndex((c) => c.hash.startsWith(opts.startAfter!));
    if (idx >= 0) {
      commitsToProcess = commitsToProcess.slice(idx + 1);
      cb.onLog(`Starting after ${opts.startAfter}, ${commitsToProcess.length} remaining`, "gray");
    }
  }

  // ── --limit filter ───────────────────────────────────────────────────
  if (opts.limit && opts.limit < commitsToProcess.length) {
    commitsToProcess = commitsToProcess.slice(0, opts.limit);
    cb.onLog(`Limited to first ${opts.limit} commits`, "gray");
  }

  summary.total = commitsToProcess.length;

  // ── --list-only: just print and exit ─────────────────────────────────
  if (listOnly) {
    for (let i = 0; i < commitsToProcess.length; i++) {
      const c = commitsToProcess[i]!;
      cb.onLog(`  ${i + 1}. ${c.hash.slice(0, 8)} ${c.message}`, "white");
    }
    return {
      summary,
      decisions: [],
      worktreePath: "",
      workBranch: "",
      auditDir: "",
      commits: commitsToProcess,
      opsNotes: [],
    };
  }

  // ── Work branch & eval worktree ─────────────────────────────────────
  // Strategy: ensure the persistent work branch exists, then create a
  // DETACHED eval worktree at its HEAD. Commits are made in the eval
  // worktree. After each approved commit, the persistent branch is
  // fast-forwarded to the new commit. This means the branch only
  // advances after validation + review approval.
  const repoName = repoPath.split("/").pop() ?? "repo";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let wbName: string;

  if (effectiveWorkBranch) {
    wbName = effectiveWorkBranch;
    const { created, reset } = await ensureWorkBranch(git, wbName, targetRef, opts.resetWorkBranch ?? false);
    if (created) cb.onLog(`Created work branch: ${wbName} from ${targetRef}`, "green");
    else if (reset) cb.onLog(`Reset work branch: ${wbName} to ${targetRef}`, "yellow");
    else cb.onLog(`Resuming work branch: ${wbName}`, "green");
  } else {
    wbName = `backmerge/${ts}`;
    await ensureWorkBranch(git, wbName, targetRef, false);
    cb.onLog(`New branch: ${wbName}`, "green");
  }

  // Resolve where the work branch currently points
  const wbHead = await resolveRef(git, wbName);
  cb.onLog(`Work branch HEAD: ${wbHead.slice(0, 8)}`, "gray");

  // Create detached eval worktree at the work branch HEAD
  const wtPath = generateWorktreePath(repoName);
  await createDetachedWorktree(git, wtPath, wbHead);
  cb.onLog(`Eval worktree (detached): ${wtPath}`, "green");
  const wtGit = createGit(wtPath);

  // ── Audit — written to the repo root, NOT the eval worktree ─────────
  // Writing inside the eval worktree would poison validation (untracked files)
  const runId = `run-${ts}`;
  const audit = new AuditLogClass(repoPath, runId);
  const runMeta: RunMetadata = {
    runId,
    startedAt: new Date().toISOString(),
    sourceRef,
    targetRef,
    workBranch: wbName,
    mergeBase,
    worktreePath: wtPath,
    totalCandidates: commitsToProcess.length,
    cherrySkipped: cherrySkipped.size,
    dryRun,
    repoPath,
  };
  audit.runStart(runMeta);

  for (const [hash, reason] of cherrySkipped) {
    const c = allSourceCommits.find((x) => x.hash === hash);
    if (c) audit.cherrySkip(hash, c.message, reason);
  }

  // ── Resume check ────────────────────────────────────────────────────
  let resumeFromIndex = 0;
  if (opts.resume && effectiveWorkBranch) {
    // Check the worktree location (persistent branch root in the repo)
    const resumeInfo = findResumableRun(repoPath, effectiveWorkBranch);
    if (resumeInfo && resumeInfo.lastCommitIndex >= 0) {
      // Restore previous decisions and skip those commits
      const prevHashes = new Set(resumeInfo.decisions.map((d) => d.commitHash));
      for (const d of resumeInfo.decisions) {
        decisions.push(d);
        updateSummary(summary, d);
      }
      // Find resume point: first commit not in previous decisions
      resumeFromIndex = commitsToProcess.findIndex((c) => !prevHashes.has(c.hash));
      if (resumeFromIndex < 0) resumeFromIndex = commitsToProcess.length; // all done
      cb.onLog(
        `Resuming from commit ${resumeFromIndex + 1}/${commitsToProcess.length} (${resumeInfo.decisions.length} already decided)`,
        "green",
      );
    }
  }

  // ── Source latest diff (cached once) ─────────────────────────────────
  const sourceLatestDiff = await getLatestCommitDiff(git, resolvedSource);

  // ── Process each commit ──────────────────────────────────────────────
  let currentBranchHead = wbHead;

  for (let i = resumeFromIndex; i < commitsToProcess.length; i++) {
    const commit = commitsToProcess[i]!;
    audit.commitStart(commit.hash, commit.message, i, commitsToProcess.length);
    cb.onCommitStart(commit, i, commitsToProcess.length);

    const decision = await processOneCommit({
      git,
      wtGit,
      wtPath,
      repoPath,
      commit,
      index: i,
      total: commitsToProcess.length,
      sourceRef,
      targetRef,
      sourceLatestDiff,
      config,
      repoCtx,
      audit,
      cb,
      dryRun,
      review,
      autoSkip,
      maxAttempts: effectiveMaxAttempts,
      commitPrefix,
      workBranch: wbName,
      workBranchHead: currentBranchHead,
    });

    // Track branch head after successful apply
    if (decision.kind === "applied" && decision.newCommitHash) {
      currentBranchHead = decision.newCommitHash;
    }

    decisions.push(decision);
    updateSummary(summary, decision);
    audit.commitDecision(decision);
    audit.saveProgress(decisions, i);
    cb.onDecision(commit, decision);
  }

  // ── Finalize ─────────────────────────────────────────────────────────
  audit.runEnd(summary, decisions);

  // Collect ops notes from all decisions that have them
  const opsNotes = decisions
    .filter((d) => d.opsNotes && d.opsNotes.length > 0)
    .map((d) => ({ commitHash: d.commitHash, commitMessage: d.commitMessage, notes: d.opsNotes! }));

  if (opsNotes.length > 0) {
    cb.onLog("", "gray");
    cb.onLog("═══ OPERATOR NOTES ═══", "yellow");
    for (const entry of opsNotes) {
      cb.onLog(`  ${entry.commitHash.slice(0, 8)} ${entry.commitMessage}:`, "yellow");
      for (const note of entry.notes) {
        cb.onLog(`    → ${note}`, "yellow");
      }
    }
    cb.onLog("═══════════════════════", "yellow");
  }

  return {
    summary,
    decisions,
    worktreePath: wtPath,
    workBranch: wbName,
    auditDir: audit.runDir,
    commits: commitsToProcess,
    opsNotes,
  };
}

// ─── Per-commit processor ────────────────────────────────────────────────────

interface ProcessOpts {
  git: SimpleGit;
  wtGit: SimpleGit;
  wtPath: string;
  repoPath: string;
  commit: CommitInfo;
  index: number;
  total: number;
  sourceRef: string;
  targetRef: string;
  sourceLatestDiff: string;
  config: BackmergeConfig;
  repoCtx: RepoContext;
  audit: AuditLog;
  cb: EngineCallbacks;
  dryRun: boolean;
  review: boolean;
  autoSkip: boolean;
  maxAttempts: number;
  commitPrefix: string;
  /** Persistent branch name — advanced after successful apply */
  workBranch: string;
  /** Where the persistent branch pointed before this commit (for CAS) */
  workBranchHead: string;
}

async function processOneCommit(o: ProcessOpts): Promise<Decision> {
  const start = Date.now();
  const { commit, audit, cb } = o;

  // ── Build per-commit context ───────────────────────────────────────
  let touchedPaths: string[] = [];
  try {
    touchedPaths = await getCommitFiles(o.git, commit.hash);
  } catch {
    /* fallback: no path info */
  }

  const commitCtx = buildCommitContext(o.repoPath, o.repoCtx, o.config, touchedPaths, commit.message);
  if (commitCtx.includedFiles.length > 0) {
    audit.writeRelevantDocs(commit.hash, 0, commitCtx.includedFiles.join("\n"));
  }

  // ── Get source diff ────────────────────────────────────────────────
  let diff: string;
  try {
    diff = await getCommitDiff(o.git, commit.hash);
    audit.writeSourcePatch(commit.hash, diff);
  } catch (e) {
    return mkFailed(commit, "analysis", (e as Error).message, start);
  }

  // ── Analyze ────────────────────────────────────────────────────────
  cb.onStatus(`Analyzing ${commit.hash.slice(0, 8)}: ${commit.message.slice(0, 50)}`);
  let analysis: CommitAnalysis;
  try {
    analysis = await analyzeCommit({
      worktreePath: o.wtPath,
      commitDiff: diff,
      commitMessage: commit.message,
      commitHash: commit.hash,
      sourceBranch: o.sourceRef,
      targetBranch: o.targetRef,
      sourceLatestDiff: o.sourceLatestDiff,
      repoContext: commitCtx.promptBlock,
    });
    audit.writeAnalysis(commit.hash, 1, analysis as unknown as Record<string, unknown>);
    cb.onAnalysis(commit, analysis);
  } catch (e) {
    audit.error("analysis", commit.hash, commit.message, (e as Error).message);
    return mkFailed(commit, "analysis", (e as Error).message, start);
  }

  // ── Auto-skip if already present ───────────────────────────────────
  if (o.autoSkip && analysis.alreadyInTarget === "yes") {
    cb.onLog(`Auto-skip ${commit.hash.slice(0, 8)}: ${commit.message} (already present)`, "blue");
    return {
      kind: "already_applied",
      commitHash: commit.hash,
      commitMessage: commit.message,
      reason: `AI: ${analysis.reasoning.slice(0, 200)}`,
      durationMs: Date.now() - start,
    };
  }

  // ── Dry-run: stop here ─────────────────────────────────────────────
  if (o.dryRun) {
    return {
      kind: "would_apply" as const,
      commitHash: commit.hash,
      commitMessage: commit.message,
      reason: analysis.applicationStrategy.slice(0, 300),
      opsNotes: analysis.opsNotes.length > 0 ? analysis.opsNotes : undefined,
      durationMs: Date.now() - start,
    };
  }

  // ── Interactive ask ────────────────────────────────────────────────
  if (o.cb.onAskApply) {
    const answer = await o.cb.onAskApply(commit, analysis);
    if (answer === "skip") {
      return {
        kind: "skip",
        commitHash: commit.hash,
        commitMessage: commit.message,
        reason: "user skipped",
        durationMs: Date.now() - start,
      };
    }
    if (answer === "quit") {
      return {
        kind: "skip",
        commitHash: commit.hash,
        commitMessage: commit.message,
        reason: "user quit",
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Apply (with retries) ───────────────────────────────────────────
  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    const headBefore = await getHead(o.wtGit);

    cb.onStatus(`Applying ${commit.hash.slice(0, 8)} (attempt ${attempt}/${o.maxAttempts})...`);
    let applyResult: ApplyResult;
    try {
      applyResult = await applyCommit({
        worktreePath: o.wtPath,
        commitDiff: diff,
        commitMessage: commit.message,
        commitHash: commit.hash,
        applicationStrategy: analysis.applicationStrategy,
        sourceBranch: o.sourceRef,
        targetBranch: o.targetRef,
        repoContext: commitCtx.promptBlock,
        commitPrefix: o.commitPrefix,
      });
      audit.writeAnalysis(commit.hash, attempt, { ...analysis, applyResult } as unknown as Record<string, unknown>);
    } catch (e) {
      audit.error("apply", commit.hash, commit.message, (e as Error).message);
      await resetHard(o.wtGit, headBefore);
      if (attempt === o.maxAttempts) return mkFailed(commit, "apply", (e as Error).message, start);
      continue;
    }

    // ── Validate ───────────────────────────────────────────────────
    cb.onStatus(`Validating ${commit.hash.slice(0, 8)}...`);
    const validation = await validateApply(o.wtGit, headBefore);

    if (!validation.valid) {
      cb.onLog(`Validation failed: ${validation.errors.join("; ")}`, "red");
      if (validation.dirtyFiles.length > 0) {
        for (const f of validation.dirtyFiles) {
          cb.onLog(`  ${f}`, "red");
        }
      }
      await resetHard(o.wtGit, headBefore);
      if (attempt === o.maxAttempts) return mkFailed(commit, "validation", validation.errors.join("; "), start);
      continue;
    }

    // ── Review gate ────────────────────────────────────────────────
    if (o.review) {
      cb.onStatus(`Claude reviewing ${commit.hash.slice(0, 8)}...`);
      let reviewResult: ReviewResult;
      let packet: ReviewPacket;
      try {
        const appliedDiff = await getAppliedDiff(o.wtGit, headBefore);
        const appliedDiffStat = await getAppliedDiffStat(o.wtGit, headBefore);

        packet = {
          commitHash: commit.hash,
          commitMessage: commit.message,
          sourceBranch: o.sourceRef,
          targetBranch: o.targetRef,
          analysis,
          appliedDiff,
          appliedDiffStat,
          sourcePatch: diff,
          relevantDocs: commitCtx.includedFiles.join("\n"),
          repoContext: commitCtx.promptBlock,
          reviewStrictness: o.config.reviewStrictness ?? "normal",
        };
        writeReviewPacket(audit, packet, attempt);

        const headBeforeReview = await getHead(o.wtGit);
        reviewResult = await reviewAppliedDiff(o.wtPath, packet);
        audit.writeReviewResult(commit.hash, attempt, reviewResult as unknown as Record<string, unknown>);

        // Verify reviewer didn't mutate the worktree
        const mutation = await verifyReviewIntegrity(o.wtGit, headBeforeReview);
        if (mutation) {
          cb.onLog(`Review integrity violation: ${mutation} — resetting`, "red");
          audit.error("review_integrity", commit.hash, commit.message, mutation);
          await resetHard(o.wtGit, headBeforeReview);
        }

        cb.onReview?.(commit, reviewResult);
      } catch (e) {
        audit.error("review", commit.hash, commit.message, (e as Error).message);
        await resetHard(o.wtGit, headBefore);
        if (attempt === o.maxAttempts) return mkFailed(commit, "review", (e as Error).message, start);
        continue;
      }

      if (!reviewResult.approved) {
        cb.onLog(`Review rejected: ${reviewResult.issues.join("; ")}`, "red");

        // ── Fix loop: send objections back to Codex ──────────────
        const maxFixRounds = 2;
        let fixed = false;
        for (let fixRound = 1; fixRound <= maxFixRounds; fixRound++) {
          cb.onStatus(`Codex fixing review issues (round ${fixRound}/${maxFixRounds})...`);
          try {
            await fixFromReview({
              worktreePath: o.wtPath,
              commitHash: commit.hash,
              commitMessage: commit.message,
              reviewIssues: reviewResult.issues,
              sourceBranch: o.sourceRef,
              targetBranch: o.targetRef,
              repoContext: commitCtx.promptBlock,
              commitPrefix: o.commitPrefix,
            });
          } catch (e) {
            cb.onLog(`Fix failed: ${(e as Error).message}`, "red");
            break;
          }

          // Re-validate after fix
          const postFixValidation = await validateApply(o.wtGit, headBefore);
          if (!postFixValidation.valid) {
            cb.onLog(`Post-fix validation failed: ${postFixValidation.errors.join("; ")}`, "red");
            break;
          }

          // Re-review
          cb.onStatus(`Claude re-reviewing after fix (round ${fixRound})...`);
          try {
            const fixedDiff = await getAppliedDiff(o.wtGit, headBefore);
            const fixedStat = await getAppliedDiffStat(o.wtGit, headBefore);
            const fixPacket: ReviewPacket = {
              ...packet,
              appliedDiff: fixedDiff,
              appliedDiffStat: fixedStat,
            };
            const headBeforeReReview = await getHead(o.wtGit);
            reviewResult = await reviewAppliedDiff(o.wtPath, fixPacket);
            audit.writeReviewResult(commit.hash, attempt, {
              ...(reviewResult as unknown as Record<string, unknown>),
              fixRound,
            });

            // Verify re-reviewer didn't mutate
            const reReviewMutation = await verifyReviewIntegrity(o.wtGit, headBeforeReReview);
            if (reReviewMutation) {
              cb.onLog(`Re-review integrity violation: ${reReviewMutation} — resetting`, "red");
              await resetHard(o.wtGit, headBeforeReReview);
            }

            cb.onReview?.(commit, reviewResult);

            if (reviewResult.approved) {
              cb.onLog(`Review approved after fix round ${fixRound}`, "green");
              fixed = true;
              break;
            }
            cb.onLog(`Still rejected after fix round ${fixRound}: ${reviewResult.issues.join("; ")}`, "yellow");
          } catch (e) {
            cb.onLog(`Re-review failed: ${(e as Error).message}`, "red");
            break;
          }
        }

        if (!fixed) {
          // Fix loop exhausted — reset and handle
          await resetHard(o.wtGit, headBefore);

          if (o.cb.onReviewRejected) {
            const answer = await o.cb.onReviewRejected(commit, reviewResult);
            if (answer === "skip" || answer === "quit") {
              return {
                kind: "failed",
                commitHash: commit.hash,
                commitMessage: commit.message,
                reason: `Review rejected after ${maxFixRounds} fix rounds: ${reviewResult.issues.join("; ")}`,
                failedPhase: "review",
                reviewApproved: false,
                reviewIssues: reviewResult.issues,
                durationMs: Date.now() - start,
              };
            }
            // "retry" continues the outer attempt loop
            continue;
          }

          if (attempt === o.maxAttempts) {
            return {
              kind: "failed",
              commitHash: commit.hash,
              commitMessage: commit.message,
              reason: `Review rejected after ${maxFixRounds} fix rounds: ${reviewResult.issues.join("; ")}`,
              failedPhase: "review",
              reviewApproved: false,
              reviewIssues: reviewResult.issues,
              durationMs: Date.now() - start,
            };
          }
          continue;
        }
      }

      cb.onLog(`Review approved (${reviewResult.confidence})`, "green");
    }

    // ── Validate decision invariants ───────────────────────────────
    const headAfter = await getHead(o.wtGit);
    const d: Decision = {
      kind: "applied",
      commitHash: commit.hash,
      commitMessage: commit.message,
      reason: applyResult.notes || "Applied successfully",
      newCommitHash: validation.newCommitHash ?? undefined,
      filesChanged: applyResult.filesChanged,
      reviewApproved: o.review ? true : undefined,
      opsNotes: analysis.opsNotes.length > 0 ? analysis.opsNotes : undefined,
      durationMs: Date.now() - start,
    };

    const invariantErrors = validateDecision(d, headBefore, headAfter, o.dryRun);
    if (invariantErrors.length > 0) {
      cb.onLog(`Decision invariant violated: ${invariantErrors.join("; ")}`, "red");
      audit.error("invariant", commit.hash, commit.message, invariantErrors.join("; "));
      // Hard fail: reset and mark as failed
      await resetHard(o.wtGit, headBefore);
      return mkFailed(commit, "invariant", `Decision invariant violated: ${invariantErrors.join("; ")}`, start);
    }

    // ── Advance the persistent branch (compare-and-swap) ─────────
    try {
      await advanceBranch(o.git, o.workBranch, headAfter, o.workBranchHead);
      cb.onLog(`Advanced ${o.workBranch} → ${headAfter.slice(0, 8)}`, "green");
    } catch (e) {
      // CAS failed — someone else moved the branch concurrently
      cb.onLog(`Branch advance failed (concurrent move?): ${(e as Error).message}`, "red");
      audit.error("branch_advance", commit.hash, commit.message, (e as Error).message);
      await resetHard(o.wtGit, headBefore);
      return mkFailed(commit, "branch_advance", `CAS failed: ${(e as Error).message}`, start);
    }

    cb.onLog(`Applied ${commit.hash.slice(0, 8)}: ${commit.message}`, "green");
    if (applyResult.filesChanged.length > 0) {
      cb.onLog(`  files: ${applyResult.filesChanged.join(", ")}`, "gray");
    }
    return d;
  }

  // Should not reach here
  return mkFailed(commit, "apply", "Exhausted all attempts", start);
}

function mkFailed(commit: CommitInfo, phase: string, error: string, start: number): Decision {
  return {
    kind: "failed",
    commitHash: commit.hash,
    commitMessage: commit.message,
    reason: error,
    error,
    failedPhase: phase,
    durationMs: Date.now() - start,
  };
}
