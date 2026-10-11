/**
 * Pure kernel logic — no IO, no bindings. Unit-tested with `node --test`
 * (Node 26 type stripping; keep syntax erasable: no enums, no namespaces).
 */

export interface TaskLike {
  id?: string;
  status?: string;
  fork_base_sha?: string | null;
  forked_at?: string | null;
  touch_set?: string | null;
  updated_at?: string;
  [k: string]: unknown;
}

export interface MergedTaskLike {
  id?: string;
  touch_set?: string | null;
  merged_at?: string | null;
}

export function workspaceName(taskId: string, attempt: number): string {
  return `task-${taskId.replace(/^tsk_/, "")}-a${attempt}`;
}

export function parseWorkspace(repo: string): { taskId: string; attempt: number } | null {
  const m = /^task-([a-z0-9]+)-a(\d+)$/.exec(repo);
  if (!m) return null;
  return { taskId: "tsk_" + m[1], attempt: Number(m[2]) };
}

export function touchSetOf(task: TaskLike): string[] {
  try {
    const v = JSON.parse(task.touch_set ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function intersects(a: string[], b: string[]): boolean {
  return a.some((f) => b.includes(f));
}

export type MergeDecision =
  | { action: "fast_forward" }
  | { action: "rebase" }
  | { action: "refork"; overlaps: string[] };

/**
 * The merge scheduler's decision for one awaiting task.
 *
 * Temporal rule (guarantees convergence): only tasks merged AFTER this task's
 * workspace was forked can conflict with it. Comparing SHAs instead of times
 * causes infinite re-fork loops on chained merges — a bug we actually shipped.
 */
export function decideMerge(
  task: TaskLike,
  mergedTasks: MergedTaskLike[],
  head: string | null,
): MergeDecision {
  const mine = touchSetOf(task);
  const mergedSince = mergedTasks.filter(
    (mt) => mt.merged_at && task.forked_at && mt.merged_at > task.forked_at,
  );
  const overlaps = mergedSince
    .filter((mt) => intersects(mine, touchSetOf(mt)))
    .map((mt) => String(mt.id ?? "?"));

  if (overlaps.length > 0) return { action: "refork", overlaps };

  const ffable = !head || !task.fork_base_sha || head === task.fork_base_sha;
  return ffable ? { action: "fast_forward" } : { action: "rebase" };
}

/** A 'merging' task whose grant has not been executed within `timeoutMs` is recovered. */
export function isStaleMerging(task: TaskLike, nowMs: number, timeoutMs: number): boolean {
  if (task.status !== "merging" || !task.updated_at) return false;
  const t = Date.parse(task.updated_at);
  return Number.isFinite(t) && nowMs - t > timeoutMs;
}

export interface ReviewVerdict {
  ok: boolean;
  verdict: "approve" | "reject";
  reason: string;
  instructions: string;
  model?: string;
  raw?: string;
}

const flattenAi = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v))
    return v
      .map((b) => (typeof b === "string" ? b : flattenAi((b as any)?.text ?? (b as any)?.response ?? "")))
      .join("");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.choices))
      return flattenAi((o.choices[0] as any)?.message?.content ?? "");
    return flattenAi(o.response ?? o.result ?? o.text ?? "");
  }
  return String(v);
};

/**
 * Parse a Workers AI response into a structured review verdict.
 * Handles: plain string | {response} | {choices:[{message:{content}}]} | content-block arrays;
 * verdict normalizes to approve|reject (anything unparseable → ok:false, caller decides fallback).
 */
export function parseReviewOutput(out: unknown): ReviewVerdict {
  const text = flattenAi(out) || (out == null ? "" : JSON.stringify(out));
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (parsed && typeof parsed.verdict === "string") {
        return {
          ok: true,
          verdict: parsed.verdict === "approve" ? "approve" : "reject",
          reason: String(parsed.reason ?? "").slice(0, 1000),
          instructions: String(parsed.instructions ?? "").slice(0, 1000),
        };
      }
    } catch {
      /* fall through */
    }
  }
  return { ok: false, verdict: "reject", reason: "", instructions: "", raw: text.slice(0, 400) };
}
