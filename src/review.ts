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

export async function reviewAppliedDiff(
  worktreePath: string,
  packet: ReviewPacket,
  onProgress?: (phase: string, msg: string) => void,
): Promise<ReviewResult> {
  const strictnessInstructions = {
    strict: "Be very strict. Any questionable change should be rejected. Err on the side of caution.",
    normal: "Be thorough but reasonable. Reject clear issues, accept minor style differences.",
    lenient: "Focus on correctness and safety. Accept reasonable adaptations even if imperfect.",
  };

  const prompt = `You are reviewing a curated merge commit. Codex adapted source commit ${packet.commitHash.slice(0, 8)} ("${packet.commitMessage}") from "${packet.sourceBranch}" and applied it to the worktree (based on "${packet.targetBranch}").

Your job: review the NEW commit that Codex just created. The diff below shows exactly what Codex changed. Verify it is correct, clean, and faithful to the source commit's intent.

## What Codex was asked to do
Source commit: ${packet.commitHash} — ${packet.commitMessage}
Analysis: ${packet.analysis.summary}
Strategy: ${packet.analysis.applicationStrategy}
Components: ${packet.analysis.affectedComponents.join(", ")}

## What Codex actually did (the commit you are reviewing):
\`\`\`diff
${packet.appliedDiff.slice(0, 30000)}
\`\`\`

## Diff stat:
${packet.appliedDiffStat}

Use \`git log -1\` and \`git show HEAD\` to inspect the actual commit in the worktree.

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
      maxTurns: undefined,
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

You MUST NOT modify the worktree. Specifically:
- NO file writes, edits, or creates
- NO git commit, git add, git reset, or any git mutation
- NO npm install, bun install, yarn install, pnpm install, or any package manager install
- NO rm, mv, cp, or any file mutation commands
- NO pip install, cargo build, go get, or anything that writes to disk

Testing guidelines:
- Only run tests that work without installing dependencies (assume deps are already installed if node_modules exists)
- Only run tests that work without API keys, secrets, or external service connections
- Before running a test, check if it needs env vars by reading the test file or relevant .env.example
- Prefer: type-checks (tsc --noEmit), linters (eslint), unit tests, build checks (forge build, go build)
- Avoid: integration tests hitting external APIs, tests requiring running databases/services
- Do NOT run bun install, npm install, or equivalent — deps are already there if they exist
- If you can't determine whether a test needs keys, skip it — don't run and fail

Your objections will be sent back to the apply agent for fixing, so be specific and actionable.`,
    },
  });

  let resultText = "";
  for await (const message of q) {
    // Stream progress from Claude's tool use
    if (onProgress && message.type === "assistant") {
      const betaMsg = (message as Record<string, unknown>).message as Record<string, unknown> | undefined;
      const content = betaMsg?.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "tool_use") {
            const name = block.name as string;
            const input = block.input as Record<string, unknown>;
            if (name === "Bash") {
              onProgress("review", `$ ${((input.command as string) ?? "").slice(0, 120)}`);
            } else if (name === "Read") {
              onProgress("review", `read ${((input.file_path as string) ?? "").replace(worktreePath + "/", "")}`);
            } else if (name === "Grep") {
              onProgress("review", `grep "${((input.pattern as string) ?? "").slice(0, 60)}"`);
            } else if (name === "Glob") {
              onProgress("review", `glob ${((input.pattern as string) ?? "").slice(0, 60)}`);
            } else {
              onProgress("review", `${name}`);
            }
          } else if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            // Show first line of Claude's thinking
            const firstLine = block.text.split("\n")[0]!.slice(0, 120);
            if (firstLine) onProgress("review", firstLine);
          }
        }
      }
    }

    if (message.type === "result") {
      const msg = message as Record<string, unknown>;
      // Structured output is in structured_output field, plain text in result
      if (msg.structured_output) {
        resultText =
          typeof msg.structured_output === "string" ? msg.structured_output : JSON.stringify(msg.structured_output);
      } else if (msg.result) {
        resultText = msg.result as string;
      }
      break;
    }
  }

  if (!resultText) {
    // Log what we actually got for debugging
    if (onProgress) onProgress("review", "WARNING: no structured_output or result in review response");
    return { approved: false, issues: ["Review produced no output"], summary: "Review failed", confidence: "low" };
  }

  if (onProgress) onProgress("review", `got ${resultText.length} chars of review output`);

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

  // Check no uncommitted changes (filter infra/reviewer artifacts)
  const status = await wtGit.status();
  const isInfra = (f: string) =>
    f.startsWith(".backmerge/") ||
    f.startsWith(".git-local/") ||
    f.startsWith("node_modules/") ||
    f.startsWith(".cache/") ||
    f.startsWith("dist/") ||
    f.startsWith("build/") ||
    f.startsWith("target/");
  const modified = status.modified.filter((f) => !isInfra(f));
  const created = status.created.filter((f) => !isInfra(f));
  const deleted = status.deleted.filter((f) => !isInfra(f));
  const notAdded = status.not_added.filter((f) => !isInfra(f));
  const dirty = modified.length + created.length + deleted.length + notAdded.length + status.conflicted.length;

  if (dirty > 0) {
    const parts: string[] = [];
    if (modified.length) parts.push(`${modified.length} modified`);
    if (notAdded.length) parts.push(`${notAdded.length} untracked`);
    if (deleted.length) parts.push(`${deleted.length} deleted`);
    if (status.conflicted.length) parts.push(`${status.conflicted.length} conflicted`);
    return `Review left dirty worktree: ${parts.join(", ")}`;
  }

  return null;
}
