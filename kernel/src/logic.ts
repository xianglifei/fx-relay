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
// ---------- deterministic policy layer (the trust gate below the LLM) ----------

export interface TaskPolicy {
  allow?: string[]; // glob allowlist; unset = allow everything not denied
  deny?: string[]; // extra deny globs on top of DEFAULT_DENY
  max_files?: number; // default 200
  max_diff_bytes?: number; // default 200_000
}

/** Paths no agent may ever touch. Deny always wins over allow. */
export const DEFAULT_DENY = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "*.keystore",
  ".ssh/**",
  ".aws/**",
  ".github/workflows/**",
];

const GLOB_META = "\\^$.|+()[]{}";

/** `*` stays within a segment, `**` crosses directories (and swallows a following `/`). */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++; // consume the second '*'
        if (pattern[i + 1] === "/") i++; // 'a/**/b' also matches 'a/b'
        re += ".*";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (GLOB_META.includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchGlob(path: string, patterns: string[]): boolean {
  // gitignore convention: a pattern without '/' matches the basename at any depth
  // (*.pem catches deploy/server.pem); patterns with '/' stay anchored to the root.
  const base = path.split("/").pop() ?? path;
  return patterns.some((p) => {
    try {
      const re = globToRegExp(p);
      return re.test(path) || (!p.includes("/") && re.test(base));
    } catch {
      return false;
    }
  });
}

const cleanList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 50)
        .map((s) => s.slice(0, 200))
    : [];

/** Sanitize an API-supplied policy: unknown keys dropped, numbers clamped. */
export function normalizePolicy(raw: unknown): TaskPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const clamp = (v: unknown, min: number, max: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : dflt;
  };
  const p: TaskPolicy = {};
  const allow = cleanList(o.allow);
  const deny = cleanList(o.deny);
  if (allow.length) p.allow = allow;
  if (deny.length) p.deny = deny;
  if (o.max_files !== undefined) p.max_files = clamp(o.max_files, 1, 10000, 200);
  if (o.max_diff_bytes !== undefined) p.max_diff_bytes = clamp(o.max_diff_bytes, 1000, 5000000, 200000);
  return p;
}

export interface PolicyViolation {
  rule: string;
  detail: string;
}

/**
 * Deterministic gate #1 — runs BEFORE the LLM review and short-circuits it.
 * A violation is a scheduling fact, not an opinion: reject with machine instructions.
 */
export function applyPolicy(
  rawPolicy: unknown,
  touchSet: string[],
  diffBytes: number,
): { ok: boolean; violations: PolicyViolation[]; instructions: string } {
  const p = normalizePolicy(rawPolicy);
  const deny = [...DEFAULT_DENY, ...(p.deny ?? [])];
  const violations: PolicyViolation[] = [];
  for (const f of touchSet) {
    if (matchGlob(f, deny)) violations.push({ rule: "deny", detail: `文件 ${f} 命中禁改清单` });
    else if (p.allow && p.allow.length && !matchGlob(f, p.allow))
      violations.push({ rule: "allow", detail: `文件 ${f} 不在本任务允许范围内` });
  }
  const maxFiles = p.max_files ?? 200;
  if (touchSet.length > maxFiles)
    violations.push({ rule: "max_files", detail: `改动 ${touchSet.length} 个文件,超过上限 ${maxFiles}` });
  const maxDiff = p.max_diff_bytes ?? 200000;
  if (diffBytes > maxDiff)
    violations.push({ rule: "max_diff_bytes", detail: `diff ${diffBytes} 字节,超过上限 ${maxDiff}` });
  const instructions = violations.length
    ? "确定性策略拦截(非 AI 审查),请收窄改动后重做:\n" +
      violations.map((v) => `- [${v.rule}] ${v.detail}`).join("\n")
    : "";
  return { ok: violations.length === 0, violations, instructions };
}

export interface CheckResult {
  cmd?: string;
  exit?: number | null;
  tail?: string;
}
export interface ChecksReport {
  tests?: CheckResult | null;
  lint?: CheckResult | null;
}

/**
 * Deterministic gate #2 — test/lint results the runner executed against the
 * fork-BASE scripts. Absent checks (old runner, no package.json) are not judged;
 * a reported non-zero exit always is. Fail-closed on what ran, tolerant of what didn't.
 */
export function evalChecks(checks: unknown): { ok: boolean; failed: string[]; instructions: string } {
  const c = (checks ?? {}) as ChecksReport;
  const failed: string[] = [];
  const parts: string[] = [];
  for (const key of ["tests", "lint"] as const) {
    const r = c[key];
    if (!r || r.exit === undefined || r.exit === null) continue;
    if (Number(r.exit) !== 0) {
      failed.push(key);
      parts.push(`- [${key}] 命令 \`${r.cmd ?? key}\` 退出码 ${r.exit}:\n${String(r.tail ?? "").slice(0, 1500)}`);
    }
  }
  return {
    ok: failed.length === 0,
    failed,
    instructions: failed.length ? "本地确定性检查未通过,请修复后重做:\n" + parts.join("\n") : "",
  };
}

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
