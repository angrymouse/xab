import simpleGit, { type SimpleGit } from "simple-git";
import { join } from "path";
import { tmpdir } from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export interface CommitValidation {
  valid: boolean;
  newCommitHash: string | null;
  newCommitCount: number;
  worktreeClean: boolean;
  conflictMarkers: string[];
  /** Files left dirty (modified/untracked/etc) with status */
  dirtyFiles: string[];
  errors: string[];
}

// ─── Core git helpers ────────────────────────────────────────────────────────

export function createGit(cwd: string): SimpleGit {
  return simpleGit(cwd);
}

export async function isGitRepo(git: SimpleGit): Promise<boolean> {
  try {
    await git.raw(["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRef(git: SimpleGit, ref: string): Promise<string> {
  const result = await git.raw(["rev-parse", "--verify", ref]);
  return result.trim();
}

export async function getHead(git: SimpleGit): Promise<string> {
  const result = await git.raw(["rev-parse", "HEAD"]);
  return result.trim();
}

export async function getBranches(git: SimpleGit): Promise<string[]> {
  const summary = await git.branch();
  const local = summary.all.filter((b) => !b.startsWith("remotes/"));
  const remote = summary.all
    .filter((b) => b.startsWith("remotes/") && !b.endsWith("/HEAD"))
    .map((b) => b.replace(/^remotes\//, ""));
  const localSet = new Set(local);
  const combined = [...local];
  for (const r of remote) {
    const shortName = r.replace(/^[^/]+\//, "");
    if (!localSet.has(shortName) && !localSet.has(r)) {
      combined.push(r);
    }
  }
  return combined;
}

export async function getMergeBase(git: SimpleGit, ref1: string, ref2: string): Promise<string> {
  const result = await git.raw(["merge-base", ref1, ref2]);
  return result.trim();
}

export async function getCommitsSince(git: SimpleGit, since: string, branch: string): Promise<CommitInfo[]> {
  const log = await git.log({ from: since, to: branch });
  return log.all.map((c) => ({ hash: c.hash, message: c.message, date: c.date, author: c.author_name })).reverse(); // oldest first
}

export async function getCommitDiff(git: SimpleGit, hash: string): Promise<string> {
  return git.show([hash, "--stat", "--patch"]);
}

export async function getCommitDiffStat(git: SimpleGit, hash: string): Promise<string> {
  return git.show([hash, "--stat"]);
}

export async function getCommitFiles(git: SimpleGit, hash: string): Promise<string[]> {
  const raw = await git.raw(["diff-tree", "--no-commit-id", "--name-only", "-r", hash]);
  return raw.trim().split("\n").filter(Boolean);
}

export async function getLatestCommitDiff(git: SimpleGit, ref: string): Promise<string> {
  return git.show([ref, "--stat", "--patch"]);
}

export async function getDescendantCommitsSince(git: SimpleGit, since: string, ref: string): Promise<CommitInfo[]> {
  const log = await git.log({ from: since, to: ref });
  return log.all.map((c) => ({ hash: c.hash, message: c.message, date: c.date, author: c.author_name }));
}

// ─── Worktree management ─────────────────────────────────────────────────────

export function generateWorktreePath(repoName: string): string {
  const id = Math.random().toString(36).slice(2, 8);
  return join(tmpdir(), `backmerge-${repoName}-${id}`);
}

export async function createWorktree(git: SimpleGit, path: string, baseRef: string, newBranch: string): Promise<void> {
  await git.raw(["worktree", "add", "-b", newBranch, path, baseRef]);
}

export async function createWorktreeFromBranch(git: SimpleGit, path: string, branch: string): Promise<void> {
  await git.raw(["worktree", "add", path, branch]);
}

/** Create a detached worktree at a specific commit (no branch checked out) */
export async function createDetachedWorktree(git: SimpleGit, path: string, ref: string): Promise<void> {
  await git.raw(["worktree", "add", "--detach", path, ref]);
}

/**
 * Advance a branch ref with compare-and-swap.
 * Only updates if the branch currently points to `expectedOld`.
 * Throws if the ref was moved concurrently.
 */
export async function advanceBranch(
  git: SimpleGit,
  branch: string,
  newRef: string,
  expectedOld: string,
): Promise<void> {
  await git.raw(["update-ref", `refs/heads/${branch}`, newRef, expectedOld]);
}

export async function removeWorktree(git: SimpleGit, path: string): Promise<void> {
  try {
    await git.raw(["worktree", "remove", path, "--force"]);
  } catch {
    /* ignore cleanup errors */
  }
}

// ─── Persistent work branch ─────────────────────────────────────────────────

export async function branchExists(git: SimpleGit, name: string): Promise<boolean> {
  try {
    await git.raw(["rev-parse", "--verify", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createBranch(git: SimpleGit, name: string, startPoint: string): Promise<void> {
  await git.raw(["branch", name, startPoint]);
}

export async function resetBranch(git: SimpleGit, name: string, ref: string): Promise<void> {
  await git.raw(["update-ref", `refs/heads/${name}`, ref]);
}

/**
 * Ensure a work branch exists. If it exists, use it as-is (resume).
 * If it doesn't exist, create it from targetRef.
 * If resetWorkBranch is true, force-reset it to targetRef.
 * Returns whether the branch was freshly created.
 */
export async function ensureWorkBranch(
  git: SimpleGit,
  name: string,
  targetRef: string,
  resetWorkBranch: boolean,
): Promise<{ created: boolean; reset: boolean }> {
  const exists = await branchExists(git, name);

  if (exists && resetWorkBranch) {
    const resolved = await resolveRef(git, targetRef);
    await resetBranch(git, name, resolved);
    return { created: false, reset: true };
  }

  if (exists) {
    return { created: false, reset: false };
  }

  const resolved = await resolveRef(git, targetRef);
  await createBranch(git, name, resolved);
  return { created: true, reset: false };
}

// ─── Cherry-pick detection ───────────────────────────────────────────────────

export async function findAlreadyCherryPicked(
  git: SimpleGit,
  targetRef: string,
  sourceRef: string,
  mergeBase: string,
): Promise<{ needed: Set<string>; skipped: Map<string, string> }> {
  const needed = new Set<string>();
  const skipped = new Map<string, string>();

  try {
    const result = await git.raw(["cherry", targetRef, sourceRef, mergeBase]);
    for (const line of result.trim().split("\n")) {
      if (!line.trim()) continue;
      const prefix = line[0];
      const hash = line.slice(2).trim();
      if (prefix === "-") {
        skipped.set(hash, "patch-id match (already cherry-picked)");
      } else {
        needed.add(hash);
      }
    }
  } catch {
    // Fallback: treat all as needed
    const commits = await getCommitsSince(git, mergeBase, sourceRef);
    for (const c of commits) needed.add(c.hash);
  }

  return { needed, skipped };
}

// ─── Post-apply validation ───────────────────────────────────────────────────

export async function validateApply(worktreeGit: SimpleGit, beforeHash: string): Promise<CommitValidation> {
  const errors: string[] = [];
  let newCommitHash: string | null = null;
  let newCommitCount = 0;

  try {
    const log = await worktreeGit.raw(["log", "--format=%H", `${beforeHash}..HEAD`]);
    const newHashes = log.trim().split("\n").filter(Boolean);
    newCommitCount = newHashes.length;

    if (newCommitCount === 0) {
      errors.push("No new commit created");
    } else if (newCommitCount === 1) {
      newCommitHash = newHashes[0]!;
    } else {
      errors.push(`Expected 1 new commit, found ${newCommitCount}`);
      newCommitHash = newHashes[0]!;
    }
  } catch (e) {
    errors.push(`Failed to check commits: ${(e as Error).message}`);
  }

  const status = await worktreeGit.status();
  // Filter out infrastructure artifacts from dirty checks
  // .backmerge/ = our audit files, .git-local/ = Codex sandbox artifacts
  const isInfra = (f: string) =>
    f.startsWith(".backmerge/") ||
    f.startsWith(".backmerge\\") ||
    f.startsWith(".git-local/") ||
    f.startsWith(".git-local\\");
  const modified = status.modified.filter((f) => !isInfra(f));
  const created = status.created.filter((f) => !isInfra(f));
  const deleted = status.deleted.filter((f) => !isInfra(f));
  const notAdded = status.not_added.filter((f) => !isInfra(f));
  const conflicted = status.conflicted.filter((f) => !isInfra(f));

  const worktreeClean =
    modified.length === 0 &&
    created.length === 0 &&
    deleted.length === 0 &&
    conflicted.length === 0 &&
    notAdded.length === 0;

  const dirtyFiles: string[] = [];
  if (!worktreeClean) {
    for (const f of modified) dirtyFiles.push(`M ${f}`);
    for (const f of notAdded) dirtyFiles.push(`? ${f}`);
    for (const f of deleted) dirtyFiles.push(`D ${f}`);
    for (const f of conflicted) dirtyFiles.push(`C ${f}`);
    errors.push(`Working tree not clean (${dirtyFiles.length} files): ${dirtyFiles.join(", ")}`);
  }

  const conflictMarkers: string[] = [];
  if (newCommitHash) {
    try {
      const diffFiles = await worktreeGit.raw(["diff-tree", "--no-commit-id", "--name-only", "-r", newCommitHash]);
      for (const file of diffFiles.trim().split("\n").filter(Boolean)) {
        try {
          const content = await worktreeGit.raw(["show", `HEAD:${file}`]);
          if (/^<{7}\s|^>{7}\s|^={7}$/m.test(content)) {
            conflictMarkers.push(file);
          }
        } catch {
          /* binary or deleted */
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (conflictMarkers.length > 0) {
    errors.push(`Conflict markers in: ${conflictMarkers.join(", ")}`);
  }

  return {
    valid: errors.length === 0,
    newCommitHash,
    newCommitCount,
    worktreeClean,
    conflictMarkers,
    dirtyFiles,
    errors,
  };
}

export async function getAppliedDiff(worktreeGit: SimpleGit, beforeHash: string): Promise<string> {
  return worktreeGit.raw(["diff", beforeHash, "HEAD"]);
}

export async function getAppliedDiffStat(worktreeGit: SimpleGit, beforeHash: string): Promise<string> {
  return worktreeGit.raw(["diff", "--stat", beforeHash, "HEAD"]);
}

export async function resetHard(git: SimpleGit, ref: string): Promise<void> {
  await git.raw(["reset", "--hard", ref]);
  // Clean untracked files but exclude infrastructure artifacts
  await git.raw(["clean", "-fd", "--exclude=.backmerge", "--exclude=.git-local"]);
}

// ─── Fetch / reset ───────────────────────────────────────────────────────────

export async function fetchOrigin(git: SimpleGit): Promise<string> {
  await git.fetch(["--all", "--prune"]);
  return "Fetched all remotes";
}

export async function resetBranchToRemote(git: SimpleGit, branch: string): Promise<string> {
  try {
    const remote = (await git.raw(["config", `branch.${branch}.remote`])).trim();
    const remoteBranch = `${remote}/${branch}`;
    await git.raw(["rev-parse", "--verify", remoteBranch]);
    await git.raw(["update-ref", `refs/heads/${branch}`, remoteBranch]);
    return `Reset ${branch} → ${remoteBranch}`;
  } catch {
    return `No remote tracking for ${branch}, skipped`;
  }
}

export async function fetchAndReset(git: SimpleGit, branches: string[]): Promise<string[]> {
  const logs: string[] = [];
  logs.push(await fetchOrigin(git));
  for (const branch of branches) {
    logs.push(await resetBranchToRemote(git, branch));
  }
  return logs;
}
