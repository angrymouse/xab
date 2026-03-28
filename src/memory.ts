/**
 * Merge memory — accumulates learnings across commits.
 *
 * Stored as .backmerge/memory.jsonl in the repo root.
 * Each entry is a discovery from a previous commit's analysis/apply.
 * Injected into every subsequent commit's AI context.
 * GC'd by the AI after each commit to prune stale/useless entries.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface MemoryEntry {
  /** What kind of discovery */
  type: "path_mapping" | "pattern" | "codebase" | "architecture" | "convention" | "warning";
  /** Short key for dedup */
  key: string;
  /** The actual learning */
  value: string;
  /** Which commit discovered this */
  source: string;
  /** When discovered */
  ts: string;
  /** How many commits have seen this (incremented on GC keep) */
  useCount: number;
}

export class MergeMemory {
  private entries: MemoryEntry[] = [];
  private filePath: string;
  private maxEntries = 50;

  constructor(repoPath: string) {
    this.filePath = join(repoPath, ".backmerge", "memory.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      this.entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as MemoryEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is MemoryEntry => e !== null);
    } catch {
      /* start empty */
    }
  }

  private save(): void {
    const dir = join(this.filePath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  get all(): MemoryEntry[] {
    return this.entries;
  }

  get count(): number {
    return this.entries.length;
  }

  /** Add new discoveries from a commit. Deduplicates by key. */
  addDiscoveries(discoveries: Array<{ type: string; key: string; value: string }>, commitHash: string): number {
    let added = 0;
    for (const d of discoveries) {
      const existing = this.entries.find((e) => e.key === d.key);
      if (existing) {
        // Update value if it changed
        if (existing.value !== d.value) {
          existing.value = d.value;
          existing.source = commitHash;
          existing.ts = new Date().toISOString();
        }
        existing.useCount++;
      } else {
        this.entries.push({
          type: d.type as MemoryEntry["type"],
          key: d.key,
          value: d.value,
          source: commitHash,
          ts: new Date().toISOString(),
          useCount: 1,
        });
        added++;
      }
    }
    // Hard cap — drop oldest if over limit
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.save();
    return added;
  }

  /** Replace entries with the GC'd set from the AI. */
  applyGC(kept: Array<{ key: string; value: string }>): number {
    const keptKeys = new Set(kept.map((k) => k.key));
    const before = this.entries.length;

    // Update values for kept entries, remove the rest
    const newEntries: MemoryEntry[] = [];
    for (const k of kept) {
      const existing = this.entries.find((e) => e.key === k.key);
      if (existing) {
        existing.value = k.value; // AI may have refined the wording
        existing.useCount++;
        newEntries.push(existing);
      } else {
        // AI added a new entry during GC (refinement)
        newEntries.push({
          type: "pattern",
          key: k.key,
          value: k.value,
          source: "gc",
          ts: new Date().toISOString(),
          useCount: 1,
        });
      }
    }

    this.entries = newEntries;
    this.save();
    return before - this.entries.length;
  }

  /** Format memory for injection into AI prompts. */
  toPromptBlock(): string {
    if (this.entries.length === 0) return "";
    const lines = this.entries.map((e) => `[${e.type}] ${e.key}: ${e.value}`);
    return `--- Merge memory (${this.entries.length} learnings from previous commits) ---\n${lines.join("\n")}`;
  }
}
