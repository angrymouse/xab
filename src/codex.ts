/**
 * Codex SDK orchestration — analyze and apply commits.
 *
 * Each commit gets a fresh Codex instance (isolated context).
 * Prompts emphasize curated merge semantics, not blind cherry-pick.
 */

import { Codex } from "@openai/codex-sdk";
import { execSync } from "child_process";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export interface CommitAnalysis {
  summary: string;
  alreadyInTarget: "yes" | "no" | "partial";
  reasoning: string;
  applicationStrategy: string;
  affectedComponents: string[];
  /** Ops notes — only populated when the commit requires operator action beyond a code deploy */
  opsNotes: string[];
}

export interface ApplyResult {
  applied: boolean;
  filesChanged: string[];
  commitMessage: string;
  notes: string;
  adaptations: string;
}

const analysisSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Concise summary of what this commit does" },
    alreadyInTarget: {
      type: "string",
      enum: ["yes", "no", "partial"],
      description:
        "Whether the target branch already has this change. 'yes' = exact same functionality exists. 'partial' = some parts exist. 'no' = missing.",
    },
    reasoning: { type: "string", description: "Evidence — list which files you checked and what you found" },
    applicationStrategy: {
      type: "string",
      description: "Step-by-step strategy for applying. If already present, say 'skip'.",
    },
    affectedComponents: {
      type: "array",
      items: { type: "string" },
      description: "Top-level directories/components affected (e.g. 'api', 'frontend', 'contracts')",
    },
    opsNotes: {
      type: "array",
      items: { type: "string" },
      description:
        "Operator action items ONLY if this commit requires something beyond a standard code deploy+restart. Examples: new env vars to add, database migrations to run, new services to deploy, infrastructure changes, config file updates on servers. Leave as empty array [] if no operator action is needed — a normal code deploy does NOT count.",
    },
  },
  required: ["summary", "alreadyInTarget", "reasoning", "applicationStrategy", "affectedComponents", "opsNotes"],
  additionalProperties: false,
} as const;

const applyResultSchema = {
  type: "object",
  properties: {
    applied: { type: "boolean", description: "Whether changes were applied and committed" },
    filesChanged: { type: "array", items: { type: "string" }, description: "File paths created/modified/deleted" },
    commitMessage: { type: "string", description: "The commit message used" },
    notes: { type: "string", description: "Issues encountered or adaptations made" },
    adaptations: { type: "string", description: "How the changes were adapted to fit the target codebase" },
  },
  required: ["applied", "filesChanged", "commitMessage", "notes", "adaptations"],
  additionalProperties: false,
} as const;

// ─── Utilities ───────────────────────────────────────────────────────────────

export function checkCodexInstalled(): boolean {
  try {
    execSync("codex --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const CHUNK_SIZE = 24000;

/** Split a diff into chunks for multi-turn feeding. First chunk includes stat header. */
function splitDiff(diff: string): string[] {
  if (diff.length <= CHUNK_SIZE) return [diff];

  const chunks: string[] = [];
  // First chunk: include stat header + as much patch as fits
  const statEnd = diff.indexOf("\n\n");
  const firstEnd = statEnd > 0 ? Math.max(statEnd, CHUNK_SIZE) : CHUNK_SIZE;
  chunks.push(diff.slice(0, Math.min(firstEnd, diff.length)));

  // Remaining chunks: split on file boundaries (diff --git) when possible
  let pos = chunks[0]!.length;
  while (pos < diff.length) {
    let end = pos + CHUNK_SIZE;
    if (end < diff.length) {
      // Try to break at a file boundary
      const boundary = diff.lastIndexOf("\ndiff --git ", end);
      if (boundary > pos) end = boundary;
    }
    chunks.push(diff.slice(pos, Math.min(end, diff.length)));
    pos = end;
  }
  return chunks;
}

/** For backward compat — single-string truncation for contexts that don't support multi-turn */
function truncateDiff(diff: string, maxLen: number): string {
  if (diff.length <= maxLen) return diff;
  const statEnd = diff.indexOf("\n\n");
  if (statEnd === -1 || statEnd > maxLen) return diff.slice(0, maxLen) + "\n\n... [truncated]";
  const stat = diff.slice(0, statEnd);
  const remaining = maxLen - stat.length - 50;
  if (remaining <= 0) return stat + "\n\n... [patch truncated]";
  return stat + diff.slice(statEnd, statEnd + remaining) + "\n\n... [patch truncated]";
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    /* try extract */
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

// ─── Stream helper ───────────────────────────────────────────────────────────

async function runStreamedWithProgress(
  thread: ReturnType<InstanceType<typeof Codex>["startThread"]>,
  prompt: string,
  onProgress: ProgressFn | undefined,
  turnOpts?: { outputSchema?: unknown },
): Promise<string> {
  if (!onProgress) {
    const turn = await thread.run(prompt, turnOpts);
    return turn.finalResponse;
  }

  const { events } = await thread.runStreamed(prompt, turnOpts);
  let finalResponse = "";

  for await (const event of events) {
    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      const item = event.item as Record<string, unknown>;
      switch (item.type) {
        case "command_execution": {
          const cmd = (item.command as string) ?? "";
          const status = item.status as string;
          if (status === "in_progress") {
            // Detect file-read patterns and label them nicely
            const readMatch = cmd.match(/\b(?:cat|head|tail|less|bat)\s+['"]?([^\s'"]+)/);
            const sedMatch = cmd.match(/\bsed\s+-n\s+['"]?\d+.*?['"]?\s+['"]?([^\s'"]+)/);
            const rgMatch = cmd.match(/\brg\s+(?:-[^\s]+\s+)*['"]?([^'"]+?)['"]?\s+([^\s]+)/);
            if (readMatch) {
              onProgress("read", readMatch[1]!);
            } else if (sedMatch) {
              onProgress("read", sedMatch[1]!);
            } else if (rgMatch) {
              onProgress("grep", `"${rgMatch[1]}" in ${rgMatch[2]}`);
            } else {
              onProgress("exec", `$ ${cmd.slice(0, 120)}`);
            }
          } else if (status === "completed") {
            const output = (item.aggregated_output as string) ?? "";
            if (output) {
              const lines = output.split("\n").filter(Boolean);
              for (const line of lines.slice(-3)) {
                onProgress("exec", `  ${line.slice(0, 120)}`);
              }
            }
          }
          break;
        }
        case "file_change": {
          const changes = (item.changes as Array<{ path: string; kind: string }>) ?? [];
          for (const c of changes) {
            onProgress("file", `${c.kind} ${c.path}`);
          }
          break;
        }
        case "mcp_tool_call": {
          const tool = (item.tool as string) ?? "";
          const args = (item.arguments as Record<string, unknown>) ?? {};
          const status = item.status as string;
          if (status === "in_progress") {
            if (tool.toLowerCase().includes("read")) {
              onProgress("read", ((args.file_path as string) ?? (args.path as string) ?? tool).slice(0, 120));
            } else if (tool.toLowerCase().includes("grep") || tool.toLowerCase().includes("search")) {
              onProgress("grep", `"${((args.pattern as string) ?? "").slice(0, 60)}" ${args.path ?? ""}`);
            } else if (tool.toLowerCase().includes("glob") || tool.toLowerCase().includes("find")) {
              onProgress("glob", ((args.pattern as string) ?? (args.path as string) ?? tool).slice(0, 120));
            } else {
              onProgress("tool", `${tool} ${JSON.stringify(args).slice(0, 80)}`);
            }
          }
          break;
        }
        case "reasoning": {
          const text = (item.text as string) ?? "";
          if (text && event.type === "item.completed") {
            onProgress("think", text.split("\n")[0]!.slice(0, 120));
          }
          break;
        }
        case "agent_message": {
          if (event.type === "item.completed") {
            finalResponse = (item.text as string) ?? "";
          }
          break;
        }
      }
    }
  }

  return finalResponse;
}

// ─── Curated merge preamble ──────────────────────────────────────────────────

const MERGE_PREAMBLE = `## Important: this is a CURATED MERGE, not a blind cherry-pick

You are helping merge changes from a source branch into a target branch that may have diverged significantly.

Rules:
- Preserve the target branch's architecture, conventions, and improvements
- Merge the INTENT of the source commit, not its literal paths/code
- The target may have different file locations, naming, or implementations
- Only apply changes that are genuinely useful to the target
- Do not regress target-specific improvements or features
- Prefer adapting behavior into the target's existing code structure
- If the source commit doesn't make sense for the target, explain why
`;

// ─── Analyze ─────────────────────────────────────────────────────────────────

export type ProgressFn = (phase: string, msg: string) => void;

export interface AnalyzeOptions {
  worktreePath: string;
  commitDiff: string;
  commitMessage: string;
  commitHash: string;
  sourceBranch: string;
  targetBranch: string;
  sourceLatestDiff: string;
  repoContext?: string;
  onProgress?: ProgressFn;
}

export async function analyzeCommit(opts: AnalyzeOptions): Promise<CommitAnalysis> {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: opts.worktreePath,
    sandboxMode: "danger-full-access",
    model: "gpt-5.4",
    modelReasoningEffort: "high",
  });

  const diffChunks = splitDiff(opts.commitDiff);

  // Feed diff chunks across turns — first turn includes context
  const firstPrompt = `${MERGE_PREAMBLE}
${opts.repoContext ? `## Repository context\n${opts.repoContext}\n` : ""}
## Source commit (from "${opts.sourceBranch}")
Hash: ${opts.commitHash}
Message: ${opts.commitMessage}

### Diff${diffChunks.length > 1 ? ` (part 1/${diffChunks.length})` : ""}:
\`\`\`diff
${diffChunks[0]}
\`\`\`

## Latest state of source branch (for context):
\`\`\`diff
${truncateDiff(opts.sourceLatestDiff, 10000)}
\`\`\`

${diffChunks.length > 1 ? "I will send the remaining diff parts next. Read them all before analyzing." : ""}

## Your task
You are looking at a worktree based on the TARGET branch "${opts.targetBranch}".

1. Read the target worktree files affected by this commit
2. Summarize what the source commit does
3. Determine if the target already has this functionality:
   - "yes" = exact same functionality exists (check every affected file)
   - "partial" = some parts exist
   - "no" = missing
4. If not fully present, describe a step-by-step strategy for applying cleanly
5. List which top-level components/directories are affected
6. Consider: does this change make sense for the target? Is it useful?
7. Check if this commit requires any operator action beyond a normal code deploy:
   - New environment variables added to .env / .env.example? → note which ones
   - Database schema changes or migrations? → note what to run
   - New services, containers, or infrastructure to deploy? → note what
   - Config files that need manual updates on servers? → note which
   - Dependencies on external services being added or removed? → note what
   - If the commit is just normal code changes that only need a deploy+restart, leave opsNotes as []`;

  // Feed additional diff chunks if needed, then get structured output with streaming
  let response: string;
  if (diffChunks.length > 1) {
    await thread.run(firstPrompt);
    for (let i = 1; i < diffChunks.length - 1; i++) {
      await thread.run(
        `### Diff (part ${i + 1}/${diffChunks.length}):\n\`\`\`diff\n${diffChunks[i]}\n\`\`\`\n\nContinue reading. More parts coming.`,
      );
    }
    const lastIdx = diffChunks.length - 1;
    response = await runStreamedWithProgress(
      thread,
      `### Diff (part ${lastIdx + 1}/${diffChunks.length} — final):\n\`\`\`diff\n${diffChunks[lastIdx]}\n\`\`\`\n\nYou now have the complete diff. Analyze and produce your structured response.`,
      opts.onProgress,
      { outputSchema: analysisSchema },
    );
  } else {
    response = await runStreamedWithProgress(thread, firstPrompt, opts.onProgress, { outputSchema: analysisSchema });
  }
  return parseJson<CommitAnalysis>(response, {
    summary: response.slice(0, 500),
    alreadyInTarget: "no",
    reasoning: "Could not parse structured output",
    applicationStrategy: "Manual review recommended",
    affectedComponents: [],
    opsNotes: [],
  });
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export interface ApplyOptions {
  worktreePath: string;
  commitDiff: string;
  commitMessage: string;
  commitHash: string;
  applicationStrategy: string;
  sourceBranch: string;
  targetBranch: string;
  repoContext?: string;
  commitPrefix: string;
  onProgress?: ProgressFn;
}

export async function applyCommit(opts: ApplyOptions): Promise<ApplyResult> {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: opts.worktreePath,
    sandboxMode: "danger-full-access",
    model: "gpt-5.4",
    modelReasoningEffort: "high",
  });

  const commitMsg = `${opts.commitPrefix} ${opts.commitMessage} (from ${opts.commitHash.slice(0, 8)})`;

  const diffChunks = splitDiff(opts.commitDiff);

  const instructions = `## Application strategy:
${opts.applicationStrategy}

## Instructions — clean curated merge
- Read the affected files in the worktree FIRST to understand the target's current state
- Apply changes so the result is clean, compiling, and conflict-free
- Adapt to the target's code style, imports, and architecture
- If the target already has a different version of the same logic, merge both intents
- Preserve the target's existing improvements — do not regress
- Create or modify files as needed; delete files if the source commit deleted them
- No conflict markers, dead code, or TODO placeholders
- If impossible to apply cleanly, explain why in notes

## CRITICAL — you MUST commit your changes
After making all file changes, you MUST run these two commands as your FINAL action:

    git add -A
    git commit -m "${commitMsg.replace(/"/g, '\\"')}"

If you do not run both commands, your work will be discarded. This is not optional.
The validation system checks for exactly one new git commit. Zero commits = failure.

Report what you did.

MAKE SURE TO ACTUALLY GIT COMMIT, NOT JUST MODIFY FILES.`;

  const firstPrompt = `${MERGE_PREAMBLE}
${opts.repoContext ? `## Repository context\n${opts.repoContext}\n` : ""}
## Source commit (from "${opts.sourceBranch}")
Hash: ${opts.commitHash}
Message: ${opts.commitMessage}

### Diff${diffChunks.length > 1 ? ` (part 1/${diffChunks.length})` : ""}:
\`\`\`diff
${diffChunks[0]}
\`\`\`

${diffChunks.length > 1 ? "I will send the remaining diff parts next. Read them all before applying." : instructions}`;

  let response: string;
  if (diffChunks.length > 1) {
    await thread.run(firstPrompt);
    for (let i = 1; i < diffChunks.length - 1; i++) {
      await thread.run(
        `### Diff (part ${i + 1}/${diffChunks.length}):\n\`\`\`diff\n${diffChunks[i]}\n\`\`\`\n\nContinue reading. More parts coming.`,
      );
    }
    const lastIdx = diffChunks.length - 1;
    response = await runStreamedWithProgress(
      thread,
      `### Diff (part ${lastIdx + 1}/${diffChunks.length} — final):\n\`\`\`diff\n${diffChunks[lastIdx]}\n\`\`\`\n\nYou now have the complete diff.\n\n${instructions}`,
      opts.onProgress,
      { outputSchema: applyResultSchema },
    );
  } else {
    response = await runStreamedWithProgress(thread, firstPrompt, opts.onProgress, { outputSchema: applyResultSchema });
  }
  return parseJson<ApplyResult>(response, {
    applied: false,
    filesChanged: [],
    commitMessage: commitMsg,
    notes: response.slice(0, 1000),
    adaptations: "",
  });
}

// ─── Fix (review objections → Codex) ─────────────────────────────────────────

export interface FixOptions {
  worktreePath: string;
  commitHash: string;
  commitMessage: string;
  reviewIssues: string[];
  sourceBranch: string;
  targetBranch: string;
  repoContext?: string;
  commitPrefix: string;
}

/**
 * Send Claude's review objections back to Codex to fix.
 * Codex amends the existing commit with fixes.
 */
export async function fixFromReview(opts: FixOptions): Promise<ApplyResult> {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: opts.worktreePath,
    sandboxMode: "danger-full-access",
    model: "gpt-5.4",
    modelReasoningEffort: "high",
  });

  const commitMsg = `${opts.commitPrefix} ${opts.commitMessage} (from ${opts.commitHash.slice(0, 8)})`;

  const prompt = `A code reviewer found issues with your previous apply of commit ${opts.commitHash.slice(0, 8)} ("${opts.commitMessage}").

${opts.repoContext ? `## Repository context\n${opts.repoContext}\n` : ""}

## Review objections — you MUST fix ALL of these:
${opts.reviewIssues.map((issue, i) => `${i + 1}. ${issue}`).join("\n")}

## Instructions
- Read the affected files to understand the current state
- Fix every issue the reviewer raised
- Do NOT introduce new problems while fixing
- The result must be a single clean commit with no issues

## CRITICAL — you MUST amend the commit after fixing
After making all fixes, you MUST run these two commands as your FINAL action:

    git add -A
    git commit --amend -m "${commitMsg.replace(/"/g, '\\"')}"

If you do not run both commands, your fixes will be discarded. This is not optional.

Report what you fixed.

MAKE SURE TO ACTUALLY GIT COMMIT, NOT JUST MODIFY FILES.`;

  const turn = await thread.run(prompt, { outputSchema: applyResultSchema });
  return parseJson<ApplyResult>(turn.finalResponse, {
    applied: false,
    filesChanged: [],
    commitMessage: commitMsg,
    notes: turn.finalResponse.slice(0, 1000),
    adaptations: "",
  });
}

// ─── Peek ────────────────────────────────────────────────────────────────────

export async function peekSourceState(worktreePath: string, sourceBranch: string, latestDiff: string): Promise<string> {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: worktreePath,
    sandboxMode: "danger-full-access",
    model: "gpt-5.4",
  });

  const prompt = `Summarize the current state of the "${sourceBranch}" branch based on its latest commit:

\`\`\`diff
${truncateDiff(latestDiff, 15000)}
\`\`\`

Describe: latest changes, general direction, key patterns, modified files.`;

  const turn = await thread.run(prompt);
  return turn.finalResponse;
}
