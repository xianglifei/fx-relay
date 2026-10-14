/**
 * Agent-output helpers, extracted for unit tests.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The agent's final stdout is its execution summary (what it did and why).
 * Keep the tail — adapters print progress first, summary last.
 */
export function summarizeAgentOutput(out, max = 1200) {
  const text = String(out ?? "").trim();
  if (!text) return null;
  return text.length > max ? "…" + text.slice(-max) : text;
}

/** Convention files we honor, in priority order (first found wins the mention). */
export const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules"];

export function conventionFilesIn(repoDir) {
  return CONVENTION_FILES.filter((f) => existsSync(path.join(repoDir, f)));
}
