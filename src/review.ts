/**
 * Claude review orchestration.
 *
 * Generates structured review packets on disk, then has Claude review from artifacts.
 * Claude is strictly read-only: Read, Glob, Grep only.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SimpleGit } from "simple-git";
import type { AuditLog } from "./audit.ts";
import type { CommitAnalysis } from "./codex.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewResult {
  approved: boolean;
  issues: string[];
  summary: string;
  confidence: "high" | "medium" | "low";
}

export interface ReviewPacket {
  commitHash: string;
  commitMessage: string;
  sourceBranch: string;
  targetBranch: string;
  analysis: CommitAnalysis;
  appliedDiff: string;
  appliedDiffStat: string;
  sourcePatch: string;
  relevantDocs: string;
  repoContext?: string;
  reviewStrictness: "strict" | "normal" | "lenient";
}

const reviewSchema = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      approved: {
        type: "boolean",
        description: "true if changes are clean, correct, and safe. false if issues need fixing.",
      },
      issues: {
        type: "array",
        items: { type: "string" },
        description: "Specific issues found. Empty if approved.",
      },
      summary: {
        type: "string",
        description: "Brief summary of what was reviewed and the verdict",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Confidence in the review assessment",
      },
    },
    required: ["approved", "issues", "summary", "confidence"],
    additionalProperties: false,
  },
};

// ─── Write review packet to disk ─────────────────────────────────────────────

export function writeReviewPacket(audit: AuditLog, packet: ReviewPacket, attempt: number): void {
  const { commitHash } = packet;

  audit.writeReviewContext(commitHash, attempt, {
    commitHash: packet.commitHash,
    commitMessage: packet.commitMessage,
    sourceBranch: packet.sourceBranch,
    targetBranch: packet.targetBranch,
    analysis: packet.analysis,
    reviewStrictness: packet.reviewStrictness,
  });

  if (packet.relevantDocs) {
    audit.writeRelevantDocs(commitHash, attempt, packet.relevantDocs);
  }

  if (packet.appliedDiffStat) {
    audit.writeDiffStat(commitHash, attempt, packet.appliedDiffStat);
  }

  if (packet.appliedDiff) {
    audit.writeAppliedPatch(commitHash, attempt, packet.appliedDiff);
  }
}

// ─── Execute Claude review ───────────────────────────────────────────────────

export async function reviewAppliedDiff(worktreePath: string, packet: ReviewPacket): Promise<ReviewResult> {
  const strictnessInstructions = {
    strict: "Be very strict. Any questionable change should be rejected. Err on the side of caution.",
    normal: "Be thorough but reasonable. Reject clear issues, accept minor style differences.",
    lenient: "Focus on correctness and safety. Accept reasonable adaptations even if imperfect.",
  };

  const prompt = `You are reviewing a curated merge. A commit from "${packet.sourceBranch}" was applied to a branch based on "${packet.targetBranch}".

## Codex analysis of the source commit
Summary: ${packet.analysis.summary}
Decision: alreadyInTarget=${packet.analysis.alreadyInTarget}
Strategy: ${packet.analysis.applicationStrategy}
Affected components: ${packet.analysis.affectedComponents.join(", ")}

## Source commit
Hash: ${packet.commitHash}
Message: ${packet.commitMessage}

## Applied diff (what was actually committed):
\`\`\`diff
${packet.appliedDiff.slice(0, 30000)}
\`\`\`

## Diff stat:
${packet.appliedDiffStat}

${packet.repoContext ? `## Repository context\n${packet.repoContext}\n` : ""}
${packet.relevantDocs ? `## Relevant documentation\n${packet.relevantDocs.slice(0, 5000)}\n` : ""}

## Full code review — think critically

You are not just verifying the diff was applied. You are doing a FULL CODE REVIEW.

### Correctness
1. Did Codex make the RIGHT decision? Should this commit have been applied at all?
2. Does the applied change actually achieve the intent of the source commit?
3. Are there logic errors introduced by adapting the code?
4. Does the change break any existing target functionality?
5. Are edge cases handled correctly?

### Cleanliness
6. NO conflict markers (<<<<<<<, =======, >>>>>>>) anywhere
7. NO dead code, commented-out old code, or TODO/FIXME placeholders
8. Imports are correct — no broken references
9. Code style matches the target branch's conventions
10. No duplicate definitions or redundant code

### Architecture
11. Does the change respect the target's architecture?
12. Were target-specific improvements preserved (not regressed)?
13. If the target had a better implementation, was it kept?
14. Are file paths and module boundaries correct for the target?

### Completeness
15. The applied changes actually match the stated strategy
16. Nothing important was missed from the source commit
17. Files created/deleted as needed

Scope your review to the diff introduced by this commit. Read the affected files in the worktree to understand the full context around the changed lines, but focus your judgment on what this commit changed.

## Strictness: ${packet.reviewStrictness}
${strictnessInstructions[packet.reviewStrictness]}

If you have ANY objections, be specific about what's wrong and how to fix it. Your issues will be sent back to the apply agent for correction.`;

  const q = query({
    prompt,
    options: {
      cwd: worktreePath,
      model: "claude-opus-4-6",
      maxTurns: 30,
      permissionMode: "default",
      outputFormat: reviewSchema,
      tools: ["Read", "Glob", "Grep", "Bash"],
      disallowedTools: ["Edit", "Write", "NotebookEdit"],
      systemPrompt: `You are a senior code reviewer for curated merge operations. Do a full code review — think about correctness, architecture, and whether the change was the right call.

You can:
- Read files for full context
- Search with Glob/Grep
- Run tests, linters, type-checkers, and build commands via Bash to verify correctness
- Run any read-only shell command (cat, ls, git diff, git log, etc.)

You MUST NOT modify the worktree in any way. No file writes, no git commits, no destructive commands.

Run relevant tests if you can determine the test command from the repo. Your objections will be sent back to the apply agent for fixing, so be specific and actionable.`,
    },
  });

  let resultText = "";
  for await (const message of q) {
    if (message.type === "result") {
      if ("result" in message) {
        resultText = message.result as string;
      }
      break;
    }
  }

  if (!resultText) {
    return { approved: false, issues: ["Review produced no output"], summary: "Review failed", confidence: "low" };
  }

  try {
    return JSON.parse(resultText) as ReviewResult;
  } catch {
    const m = resultText.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as ReviewResult;
      } catch {
        /* fall through */
      }
    }
    return {
      approved: false,
      issues: [`Unparseable review output: ${resultText.slice(0, 200)}`],
      summary: "Parse error",
      confidence: "low",
    };
  }
}

// ─── Post-review integrity check ─────────────────────────────────────────────

/**
 * Verify the reviewer didn't mutate the worktree.
 * Checks that HEAD hasn't moved and there are no uncommitted changes.
 * Returns null if clean, or an error message if mutated.
 */
export async function verifyReviewIntegrity(wtGit: SimpleGit, expectedHead: string): Promise<string | null> {
  // Check HEAD hasn't moved
  const currentHead = (await wtGit.raw(["rev-parse", "HEAD"])).trim();
  if (currentHead !== expectedHead) {
    return `Review mutated HEAD: expected ${expectedHead.slice(0, 8)}, got ${currentHead.slice(0, 8)}`;
  }

  // Check no uncommitted changes
  const status = await wtGit.status();
  const dirty =
    status.modified.length +
    status.created.length +
    status.deleted.length +
    status.not_added.length +
    status.conflicted.length;

  if (dirty > 0) {
    const parts: string[] = [];
    if (status.modified.length) parts.push(`${status.modified.length} modified`);
    if (status.created.length) parts.push(`${status.created.length} staged`);
    if (status.not_added.length) parts.push(`${status.not_added.length} untracked`);
    if (status.deleted.length) parts.push(`${status.deleted.length} deleted`);
    return `Review left dirty worktree: ${parts.join(", ")}`;
  }

  return null;
}
