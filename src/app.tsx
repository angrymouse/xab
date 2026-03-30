/**
 * Interactive TUI frontend — thin wrapper around the engine.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp, Static, Newline } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import type { CommitInfo } from "./git.ts";
import type { CommitAnalysis } from "./codex.ts";
import type { ReviewResult } from "./review.ts";
import type { EngineOptions, EngineCallbacks, EngineResult } from "./engine.ts";
import { runEngine } from "./engine.ts";
import { getBranches, createGit, isGitRepo } from "./git.ts";
import { checkCodexInstalled } from "./codex.ts";
import { VERSION as XAB_VERSION } from "./version.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase =
  | "checking-prereqs"
  | "select-target"
  | "select-source"
  | "confirm"
  | "running"
  | "show-analysis"
  | "review-result"
  | "done"
  | "error";

interface LogEntry {
  id: string;
  text: string;
  color?: string;
}

function shortHash(h: string): string {
  return h.slice(0, 8);
}

function progressBar(current: number, total: number, width = 30): string {
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${current}/${total}`;
}

function Header({
  source,
  target,
  current,
  total,
  worktree,
}: {
  source?: string;
  target?: string;
  current?: number;
  total?: number;
  worktree?: string;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">
          {"╭─ xab"}
        </Text>
        <Text dimColor> v{XAB_VERSION}</Text>
        <Text color="gray"> — curated branch reconciliation</Text>
      </Box>
      {target && source && (
        <Box>
          <Text color="cyan">{"│"} </Text>
          <Text color="green">{target}</Text>
          <Text color="gray"> ← </Text>
          <Text color="magenta">{source}</Text>
          {current !== undefined && total !== undefined && (
            <>
              <Text color="gray"> </Text>
              <Text>{progressBar(current, total)}</Text>
            </>
          )}
        </Box>
      )}
      {worktree && (
        <Box>
          <Text color="cyan">{"│"} </Text>
          <Text dimColor>worktree: {worktree}</Text>
        </Box>
      )}
      <Text color="cyan">
        {"╰"}
        {"─".repeat(60)}
      </Text>
    </Box>
  );
}

function ActionBar({ actions }: { actions: { key: string; label: string; color?: string }[] }) {
  return (
    <Box gap={2} marginTop={1}>
      {actions.map((a) => (
        <Box key={a.key}>
          <Text color="gray">[</Text>
          <Text bold color={a.color ?? "cyan"}>
            {a.key}
          </Text>
          <Text color="gray">] </Text>
          <Text>{a.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export interface AppProps {
  repoPath: string;
  engineOpts: Partial<EngineOptions>;
}

export default function App({ repoPath, engineOpts }: AppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("checking-prereqs");
  const [branches, setBranches] = useState<string[]>([]);
  const [source, setSource] = useState(engineOpts.sourceRef ?? "");
  const [target, setTarget] = useState(engineOpts.targetRef ?? "");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [currentCommit, setCurrentCommit] = useState<CommitInfo | null>(null);
  const [currentAnalysis, setCurrentAnalysis] = useState<CommitAnalysis | null>(null);
  const [currentReview, setCurrentReview] = useState<ReviewResult | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [totalCommits, setTotalCommits] = useState(0);
  const [worktreePath, setWorktreePath] = useState("");
  const [result, setResult] = useState<EngineResult | null>(null);
  const askResolverRef = useRef<((v: "apply" | "skip" | "quit") => void) | null>(null);
  const reviewResolverRef = useRef<((v: "retry" | "skip" | "quit") => void) | null>(null);

  const addLog = useCallback((text: string, color?: string) => {
    setLogs((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, text, color }]);
  }, []);

  useEffect(() => {
    if (phase !== "checking-prereqs") return;
    (async () => {
      if (!checkCodexInstalled()) {
        setError("codex CLI not found");
        setPhase("error");
        return;
      }
      const git = createGit(repoPath);
      if (!(await isGitRepo(git))) {
        setError(`${repoPath} is not a git repo`);
        setPhase("error");
        return;
      }
      const b = await getBranches(git);
      setBranches(b);
      addLog(`Found ${b.length} branches`, "gray");
      if (source && target) setPhase("confirm");
      else if (target) setPhase("select-source");
      else setPhase("select-target");
    })().catch((e) => {
      setError((e as Error).message);
      setPhase("error");
    });
  }, [phase, repoPath, addLog, source, target]);

  const startEngine = useCallback(async () => {
    setPhase("running");
    const opts: EngineOptions = { repoPath, sourceRef: source, targetRef: target, ...engineOpts };
    const cb: EngineCallbacks = {
      onLog: addLog,
      onStatus: setStatusText,
      onCommitStart(commit, index, total) {
        setCurrentCommit(commit);
        setCurrentIdx(index);
        setTotalCommits(total);
      },
      onAnalysis(_commit, analysis) {
        setCurrentAnalysis(analysis);
      },
      onDecision() {},
      onReview(_commit, review) {
        setCurrentReview(review);
      },
      async onAskApply(commit, analysis) {
        setCurrentCommit(commit);
        setCurrentAnalysis(analysis);
        setPhase("show-analysis");
        return new Promise<"apply" | "skip" | "quit">((resolve) => {
          askResolverRef.current = resolve;
        });
      },
      async onReviewRejected(commit, review) {
        setCurrentCommit(commit);
        setCurrentReview(review);
        setPhase("review-result");
        return new Promise<"retry" | "skip" | "quit">((resolve) => {
          reviewResolverRef.current = resolve;
        });
      },
    };
    try {
      const r = await runEngine(opts, cb);
      setResult(r);
      setWorktreePath(r.worktreePath);
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }, [repoPath, source, target, engineOpts, addLog]);

  useInput(
    (input, key) => {
      if (phase === "show-analysis" && askResolverRef.current) {
        if (input === "a" || input === "A") {
          askResolverRef.current("apply");
          askResolverRef.current = null;
          setPhase("running");
        } else if (input === "s" || input === "S") {
          askResolverRef.current("skip");
          askResolverRef.current = null;
          setPhase("running");
        } else if (input === "q" || input === "Q") {
          askResolverRef.current("quit");
          askResolverRef.current = null;
          setPhase("done");
        }
      } else if (phase === "review-result" && reviewResolverRef.current) {
        if (input === "r" || input === "R") {
          reviewResolverRef.current("retry");
          reviewResolverRef.current = null;
          setPhase("running");
        } else if (input === "s" || input === "S") {
          reviewResolverRef.current("skip");
          reviewResolverRef.current = null;
          setPhase("running");
        } else if (input === "q" || input === "Q") {
          reviewResolverRef.current("quit");
          reviewResolverRef.current = null;
          setPhase("done");
        }
      } else if (phase === "done" || phase === "error") {
        if (input === "q" || input === "Q" || key.escape || key.return) exit();
      } else if (phase === "confirm") {
        if (input === "y" || input === "Y" || key.return) startEngine();
        else if (input === "n" || input === "N" || key.escape) exit();
      }
    },
    { isActive: ["show-analysis", "review-result", "done", "error", "confirm"].includes(phase) },
  );

  const branchItems = branches.map((b) => ({ label: b, value: b }));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header
        source={source || undefined}
        target={target || undefined}
        current={totalCommits > 0 ? currentIdx + 1 : undefined}
        total={totalCommits || undefined}
        worktree={worktreePath || undefined}
      />
      <Static items={logs}>
        {(entry) => (
          <Text key={entry.id} color={entry.color ?? "white"}>
            {entry.text}
          </Text>
        )}
      </Static>

      {phase === "checking-prereqs" && (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Checking prerequisites...</Text>
        </Box>
      )}

      {phase === "select-target" && branches.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="green">
            Select target branch (where changes merge INTO):
          </Text>
          <SelectInput
            items={branchItems}
            onSelect={(item) => {
              setTarget(item.value);
              setPhase("select-source");
            }}
          />
        </Box>
      )}

      {phase === "select-source" && (
        <Box flexDirection="column">
          <Text bold color="magenta">
            Select source branch (where changes come FROM):
          </Text>
          <SelectInput
            items={branchItems.filter((b) => b.value !== target)}
            onSelect={(item) => {
              setSource(item.value);
              setPhase("confirm");
            }}
          />
        </Box>
      )}

      {phase === "confirm" && (
        <Box flexDirection="column">
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text bold>Confirm backmerge</Text>
            <Newline />
            <Box>
              <Text>Source: </Text>
              <Text bold color="magenta">
                {source}
              </Text>
            </Box>
            <Box>
              <Text>Target: </Text>
              <Text bold color="green">
                {target}
              </Text>
            </Box>
            {engineOpts.workBranch && (
              <Box>
                <Text>Work branch: </Text>
                <Text bold color="cyan">
                  {engineOpts.workBranch}
                </Text>
              </Box>
            )}
            {engineOpts.dryRun && <Text color="yellow">DRY RUN</Text>}
          </Box>
          <ActionBar
            actions={[
              { key: "y", label: "Proceed", color: "green" },
              { key: "n", label: "Cancel", color: "red" },
            ]}
          />
        </Box>
      )}

      {phase === "running" && (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> {statusText}</Text>
        </Box>
      )}

      {phase === "show-analysis" && currentCommit && currentAnalysis && (
        <Box flexDirection="column">
          <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginBottom={1}>
            <Box>
              <Text bold color="blue">
                Commit {currentIdx + 1}/{totalCommits}
              </Text>
              <Text color="gray"> • </Text>
              <Text color="yellow">{shortHash(currentCommit.hash)}</Text>
            </Box>
            <Text bold>{currentCommit.message}</Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
            <Box>
              <Text bold color="magenta">
                Analysis │{" "}
              </Text>
              <Text
                bold
                color={
                  currentAnalysis.alreadyInTarget === "yes"
                    ? "green"
                    : currentAnalysis.alreadyInTarget === "partial"
                      ? "yellow"
                      : "red"
                }
              >
                {currentAnalysis.alreadyInTarget === "yes"
                  ? "ALREADY PRESENT"
                  : currentAnalysis.alreadyInTarget === "partial"
                    ? "PARTIAL"
                    : "MISSING"}
              </Text>
            </Box>
            <Newline />
            <Text bold>Summary:</Text>
            <Text wrap="wrap">{currentAnalysis.summary}</Text>
            <Newline />
            <Text bold>Reasoning:</Text>
            <Text wrap="wrap" dimColor>
              {currentAnalysis.reasoning}
            </Text>
            {currentAnalysis.alreadyInTarget !== "yes" && (
              <>
                <Newline />
                <Text bold color="yellow">
                  Strategy:
                </Text>
                <Text wrap="wrap">{currentAnalysis.applicationStrategy}</Text>
              </>
            )}
          </Box>
          <ActionBar
            actions={[
              ...(currentAnalysis.alreadyInTarget !== "yes" ? [{ key: "a", label: "Apply", color: "green" }] : []),
              { key: "s", label: "Skip", color: "yellow" },
              { key: "q", label: "Quit", color: "red" },
            ]}
          />
        </Box>
      )}

      {phase === "review-result" && currentCommit && currentReview && (
        <Box flexDirection="column">
          <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginBottom={1}>
            <Text bold color="red">
              Review REJECTED — {shortHash(currentCommit.hash)}
            </Text>
            <Newline />
            <Text wrap="wrap">{currentReview.summary}</Text>
            {currentReview.issues.map((issue, i) => (
              <Text key={i} color="red">
                {" "}
                • {issue}
              </Text>
            ))}
          </Box>
          <Text color="yellow">Changes rolled back.</Text>
          <ActionBar
            actions={[
              { key: "r", label: "Retry", color: "cyan" },
              { key: "s", label: "Skip", color: "yellow" },
              { key: "q", label: "Quit", color: "red" },
            ]}
          />
        </Box>
      )}

      {phase === "done" && result && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="column" borderStyle="double" borderColor="green" paddingX={2} paddingY={1}>
            <Text bold color="green">
              Backmerge Complete
            </Text>
            <Newline />
            <Box>
              <Text>Applied: </Text>
              <Text bold color="green">
                {result.summary.applied}
              </Text>
            </Box>
            <Box>
              <Text>Would apply: </Text>
              <Text bold color="cyan">
                {result.summary.wouldApply}
              </Text>
            </Box>
            <Box>
              <Text>Already applied: </Text>
              <Text bold color="blue">
                {result.summary.alreadyApplied}
              </Text>
            </Box>
            <Box>
              <Text>Skipped: </Text>
              <Text bold color="yellow">
                {result.summary.skipped}
              </Text>
            </Box>
            <Box>
              <Text>Cherry-skipped: </Text>
              <Text bold color="cyan">
                {result.summary.cherrySkipped}
              </Text>
            </Box>
            <Box>
              <Text>Failed: </Text>
              <Text bold color="red">
                {result.summary.failed}
              </Text>
            </Box>
            <Newline />
            {result.worktreePath && <Text dimColor>Worktree: {result.worktreePath}</Text>}
            {result.workBranch && <Text dimColor>Branch: {result.workBranch}</Text>}
            {result.auditDir && <Text dimColor>Audit: {result.auditDir}</Text>}
          </Box>
          {result.opsNotes.length > 0 && (
            <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
              <Text bold color="yellow">
                Operator Notes
              </Text>
              <Newline />
              {result.opsNotes.map((entry) => (
                <Box key={entry.commitHash} flexDirection="column">
                  <Text color="yellow">
                    {entry.commitHash.slice(0, 8)} {entry.commitMessage}
                  </Text>
                  {entry.notes.map((note, i) => (
                    <Text key={i} color="yellow">
                      {" "}
                      → {note}
                    </Text>
                  ))}
                </Box>
              ))}
            </Box>
          )}
          <ActionBar actions={[{ key: "q", label: "Exit", color: "gray" }]} />
        </Box>
      )}

      {phase === "error" && (
        <Box flexDirection="column" marginTop={1}>
          <Box borderStyle="round" borderColor="red" paddingX={1}>
            <Text color="red" bold>
              Error: {error}
            </Text>
          </Box>
          <ActionBar actions={[{ key: "q", label: "Exit", color: "gray" }]} />
        </Box>
      )}
    </Box>
  );
}
