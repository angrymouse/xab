/**
 * Repo intelligence layer.
 *
 * Discovers instruction files, documentation, and project structure.
 * Produces compact per-commit context packets for AI prompts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, dirname } from "path";
function minimatch(path: string, pattern: string): boolean {
  let re = pattern;
  re = re.replace(/\*\*\//g, "\0GS\0");
  re = re.replace(/\*\*/g, "\0GA\0");
  re = re.replace(/\*/g, "\0S\0");
  re = re.replace(/\?/g, "\0Q\0");
  re = re.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\0GS\0/g, "(?:.*/)?");
  re = re.replace(/\0GA\0/g, ".*");
  re = re.replace(/\0S\0/g, "[^/]*");
  re = re.replace(/\0Q\0/g, "[^/]");
  return new RegExp(`^${re}$`).test(path);
}
import type { BackmergeConfig, DocRoute } from "./config.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepoStructure {
  type: "monorepo" | "single-project";
  topLevelDirs: string[];
  apps?: string[];
  packages?: string[];
  configFiles: string[];
  packageManager?: string;
}

export interface RepoContext {
  structure: RepoStructure;
  /** Content of discovered instruction files (AGENTS.md, CLAUDE.md, etc.) */
  instructions: Map<string, string>;
  /** All discovered doc file paths (relative to repo root) */
  docPaths: string[];
}

export interface CommitContext {
  /** Compact text block for AI prompt injection */
  promptBlock: string;
  /** Files included in context (for audit) */
  includedFiles: string[];
}

// ─── Well-known instruction files ────────────────────────────────────────────

const INSTRUCTION_FILE_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
];

const DOC_DIR_GLOBS = ["ai-docs/**/*.md", "docs/**/*.md", ".backmerge/docs/**/*.md"];

// ─── Repo structure inference ────────────────────────────────────────────────

export function inferRepoStructure(repoPath: string): RepoStructure {
  const entries = readdirSync(repoPath, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  const configFiles = files.filter((f) =>
    [
      "package.json",
      "tsconfig.json",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "nx.json",
      "lerna.json",
      "bun.lockb",
      "yarn.lock",
      "pnpm-lock.yaml",
      "Makefile",
      "foundry.toml",
      "hardhat.config.ts",
      "hardhat.config.js",
    ].includes(f),
  );

  const monoSignals = ["apps", "packages", "libs", "modules", "services", "crates", "workspace"];
  const hasMonoDir = dirs.some((d) => monoSignals.includes(d));
  const hasWorkspaceConfig = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"].some((f) =>
    files.includes(f),
  );

  let hasWorkspacesField = false;
  let packageManager: string | undefined;
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      hasWorkspacesField = Array.isArray(pkg.workspaces) || !!pkg.workspaces?.packages;
      if (pkg.packageManager) packageManager = pkg.packageManager;
      else if (existsSync(join(repoPath, "bun.lockb"))) packageManager = "bun";
      else if (existsSync(join(repoPath, "pnpm-lock.yaml"))) packageManager = "pnpm";
      else if (existsSync(join(repoPath, "yarn.lock"))) packageManager = "yarn";
    } catch {
      /* ignore */
    }
  }

  // For monorepos with multiple top-level component dirs (like Predix), detect by
  // checking if multiple top-level dirs contain their own package.json/go.mod
  const componentDirs = dirs.filter((d) => {
    const sub = join(repoPath, d);
    return (
      existsSync(join(sub, "package.json")) || existsSync(join(sub, "go.mod")) || existsSync(join(sub, "Cargo.toml"))
    );
  });
  const isComponentMonorepo = componentDirs.length >= 2;

  const isMonorepo = hasMonoDir || hasWorkspaceConfig || hasWorkspacesField || isComponentMonorepo;

  let apps: string[] | undefined;
  let packages: string[] | undefined;

  if (isMonorepo) {
    // Standard monorepo dirs
    for (const subdir of ["apps", "services"]) {
      const p = join(repoPath, subdir);
      if (existsSync(p)) {
        apps = readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => `${subdir}/${e.name}`);
      }
    }
    for (const subdir of ["packages", "libs", "modules"]) {
      const p = join(repoPath, subdir);
      if (existsSync(p)) {
        packages = readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => `${subdir}/${e.name}`);
      }
    }
    // Component-style monorepo (top-level dirs are the components)
    if (!apps && componentDirs.length >= 2) {
      apps = componentDirs;
    }
  }

  return {
    type: isMonorepo ? "monorepo" : "single-project",
    topLevelDirs: dirs,
    apps,
    packages,
    configFiles,
    packageManager,
  };
}

// ─── Instruction & doc discovery ─────────────────────────────────────────────

function discoverInstructionFiles(repoPath: string, config: BackmergeConfig): Map<string, string> {
  const found = new Map<string, string>();

  // Well-known files
  for (const candidate of INSTRUCTION_FILE_CANDIDATES) {
    const full = join(repoPath, candidate);
    if (existsSync(full)) {
      try {
        const content = readFileSync(full, "utf-8");
        // Cap at 8k chars per file to keep context manageable
        found.set(candidate, content.slice(0, 8000));
      } catch {
        /* skip unreadable */
      }
    }
  }

  // Config-specified instruction files
  for (const f of config.instructionFiles ?? []) {
    if (found.has(f)) continue;
    const full = join(repoPath, f);
    if (existsSync(full)) {
      try {
        found.set(f, readFileSync(full, "utf-8").slice(0, 8000));
      } catch {
        /* skip */
      }
    }
  }

  return found;
}

function discoverDocPaths(repoPath: string): string[] {
  const paths: string[] = [];

  function walk(dir: string, globs: string[]): void {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(repoPath, full);
      if (entry.isDirectory()) {
        walk(full, globs);
      } else if (entry.isFile() && globs.some((g) => minimatch(rel, g))) {
        paths.push(rel);
      }
    }
  }

  // Check standard doc directories
  for (const glob of DOC_DIR_GLOBS) {
    const baseDir = glob.split("/")[0]!;
    walk(join(repoPath, baseDir), [glob]);
  }

  // Also check for README.md files in subdirectories (one level deep)
  try {
    for (const entry of readdirSync(repoPath, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const readme = join(repoPath, entry.name, "README.md");
        if (existsSync(readme)) {
          paths.push(`${entry.name}/README.md`);
        }
      }
    }
  } catch {
    /* ignore */
  }

  return [...new Set(paths)].sort();
}

// ─── Build full repo context ─────────────────────────────────────────────────

export function buildRepoContext(repoPath: string, config: BackmergeConfig): RepoContext {
  const structure = inferRepoStructure(repoPath);
  const instructions = discoverInstructionFiles(repoPath, config);
  const docPaths = discoverDocPaths(repoPath);
  return { structure, instructions, docPaths };
}

// ─── Per-commit context packets ──────────────────────────────────────────────

/**
 * Given a commit's touched file paths and message, produce a compact context
 * packet with the most relevant docs/instructions for AI prompts.
 */
export function buildCommitContext(
  repoPath: string,
  repoCtx: RepoContext,
  config: BackmergeConfig,
  touchedPaths: string[],
  commitMessage: string,
): CommitContext {
  const includedFiles: string[] = [];
  const sections: string[] = [];

  // 1. Repo structure summary (always included, very compact)
  const rs = repoCtx.structure;
  const structLines = [`Repository: ${rs.type}`];
  if (rs.packageManager) structLines.push(`Package manager: ${rs.packageManager}`);
  if (rs.apps?.length) structLines.push(`Components: ${rs.apps.join(", ")}`);
  if (rs.packages?.length) structLines.push(`Packages: ${rs.packages.join(", ")}`);
  sections.push(structLines.join("\n"));

  // 2. Instruction files (always included, already capped)
  for (const [name, content] of repoCtx.instructions) {
    sections.push(`--- ${name} ---\n${content}`);
    includedFiles.push(name);
  }

  // 3. Config prompt hints
  if (config.promptHints?.length) {
    sections.push(`--- Merge hints ---\n${config.promptHints.join("\n")}`);
  }

  // 4. Path remaps
  if (config.pathRemaps?.length) {
    const lines = config.pathRemaps.map((r) => `  ${r.source} → ${r.target}${r.note ? ` (${r.note})` : ""}`);
    sections.push(`--- Path remaps ---\n${lines.join("\n")}`);
  }

  // 5. Route-matched docs
  const matchedDocs = new Set<string>();

  // Config doc routes
  for (const route of config.docRoutes ?? []) {
    if (routeMatches(route, touchedPaths, commitMessage)) {
      for (const docGlob of route.docs) {
        for (const docPath of repoCtx.docPaths) {
          if (minimatch(docPath, docGlob)) {
            matchedDocs.add(docPath);
          }
        }
      }
    }
  }

  // Heuristic: match docs by directory overlap
  const touchedTopDirs = new Set(touchedPaths.map((p) => p.split("/")[0]!).filter(Boolean));
  for (const docPath of repoCtx.docPaths) {
    const docName = docPath.toLowerCase();
    for (const dir of touchedTopDirs) {
      if (docName.includes(dir.toLowerCase())) {
        matchedDocs.add(docPath);
      }
    }
    // Also match on commit message keywords
    const msgLower = commitMessage.toLowerCase();
    const docBasename = docPath.split("/").pop()?.replace(/\.md$/, "").toLowerCase() ?? "";
    if (docBasename && msgLower.includes(docBasename)) {
      matchedDocs.add(docPath);
    }
  }

  // Load matched docs (cap total to ~4k chars)
  let docBudget = 4000;
  for (const docPath of matchedDocs) {
    if (docBudget <= 0) break;
    const full = join(repoPath, docPath);
    if (existsSync(full)) {
      try {
        const content = readFileSync(full, "utf-8");
        const chunk = content.slice(0, Math.min(2000, docBudget));
        sections.push(`--- ${docPath} ---\n${chunk}`);
        includedFiles.push(docPath);
        docBudget -= chunk.length;
      } catch {
        /* skip */
      }
    }
  }

  return {
    promptBlock: sections.join("\n\n"),
    includedFiles,
  };
}

function routeMatches(route: DocRoute, touchedPaths: string[], commitMessage: string): boolean {
  // Path glob match
  for (const glob of route.pathGlobs) {
    for (const path of touchedPaths) {
      if (minimatch(path, glob)) return true;
    }
  }
  // Keyword match
  if (route.keywords) {
    const msgLower = commitMessage.toLowerCase();
    for (const kw of route.keywords) {
      if (msgLower.includes(kw.toLowerCase())) return true;
    }
  }
  return false;
}

/** Format repo structure as a brief text block */
export function formatRepoStructure(rs: RepoStructure): string {
  const lines: string[] = [`Repository type: ${rs.type}`];
  if (rs.packageManager) lines.push(`Package manager: ${rs.packageManager}`);
  lines.push(`Top-level dirs: ${rs.topLevelDirs.join(", ")}`);
  lines.push(`Config files: ${rs.configFiles.join(", ")}`);
  if (rs.apps?.length) lines.push(`Components: ${rs.apps.join(", ")}`);
  if (rs.packages?.length) lines.push(`Packages: ${rs.packages.join(", ")}`);
  return lines.join("\n");
}
