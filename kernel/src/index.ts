/**
 * relay-kernel — a Git collaboration kernel for AI agents.
 *
 * Control plane:
 *  - task birth: fork-per-task, short repo-scoped tokens
 *  - trust gate: deterministic policy + local checks BEFORE the review agent
 *  - review agent: Workers AI structured verdict — fail-closed (errors suspend, never pass)
 *  - human gate: needs_human_review flag / review failures suspend for a human decision
 *  - merge scheduler: touch-set intersection → fast-forward grants or auto re-fork
 *  - provenance: git notes on commits, indexed in D1
 *
 * State split: D1 for scheduling, git notes for memory. Mainline stays linear.
 */

export interface Env {
  ARTIFACTS: Artifacts;
  AI: Ai;
  DB: D1Database;
  RELAY_TOKEN: string;
  RELAY_SUBMIT_TOKEN?: string;
  RELAY_NAMESPACE: string;
  RELAY_BASELINE: string;
}

import { dashboardHtml } from "./dashboard";
import {
  workspaceName,
  parseWorkspace,
  touchSetOf,
  decideMerge,
  isStaleMerging,
  parseReviewOutput,
  applyPolicy,
  evalChecks,
  normalizePolicy,
  allowTaskCreation,
} from "./logic";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const now = () => new Date().toISOString();
const safeParse = (s: string): any => {
  try { return JSON.parse(s); } catch { return null; }
};
const newTaskId = () => "tsk_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);

/** 'merging' grants older than this are recovered back to awaiting_merge. */
const MERGE_GRANT_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * 'assigned' tasks older than this are re-queued. The claim write token lives
 * 45min, so by 60min the runner provably cannot push anymore — recovery is safe.
 */
const ASSIGNED_TIMEOUT_MS = 60 * 60 * 1000;

async function logEvent(db: D1Database, taskId: string | null, type: string, payload: unknown) {
  await db
    .prepare("INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
    .bind(taskId, type, JSON.stringify(payload), now())
    .run();
}

async function getTask(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Record<string, any>>();
}

const bearerOf = (req: Request) => req.headers.get("authorization") ?? "";

async function authed(req: Request, env: Env): Promise<boolean> {
  return bearerOf(req) === `Bearer ${env.RELAY_TOKEN}`;
}

/** Read + task-submission access: admin token or the optional submit token. */
async function authSubmitter(req: Request, env: Env): Promise<boolean> {
  if (await authed(req, env)) return true;
  return !!env.RELAY_SUBMIT_TOKEN && bearerOf(req) === `Bearer ${env.RELAY_SUBMIT_TOKEN}`;
}

/** Current baseline head sha (null if indexing lags). */
async function baselineHead(env: Env, baseline: string): Promise<string | null> {
  try {
    using repo = await env.ARTIFACTS.get(baseline);
    const head = await repo.log({ limit: 1 });
    return head[0]?.hash ?? null;
  } catch { return null; }
}

/**
 * Re-fork: give the task a fresh workspace on the current baseline.
 * Context (spec + last review + what the agent did before) rides along in D1.
 */
async function reforkTask(env: Env, task: Record<string, any>, why: string) {
  const id = task.id as string;
  const attempt = (task.attempt as number) + 1;
  const name = workspaceName(id, attempt);
  using base = await env.ARTIFACTS.get(task.baseline_repo as string);
  const head = await base.log({ limit: 1 });
  const ws = await base.fork(name, {
    defaultBranchOnly: true,
    description: `Relay workspace for task ${id} (attempt ${attempt})`,
  });
  await env.DB.prepare(
    `UPDATE tasks SET status='re_forked', workspace_repo=?, workspace_remote=?, fork_base_sha=?,
       touch_set=NULL, head_sha=NULL, attempt=?, forked_at=?, updated_at=? WHERE id=?`,
  )
    .bind(ws.name, ws.remote, head[0]?.hash ?? null, attempt, now(), now(), id)
    .run();
  await logEvent(env.DB, id, "task.reforked", {
    why,
    new_workspace: ws.name,
    attempt,
  });
  return ws;
}

/** Review agent: Workers AI, structured verdict. */
export async function reviewTask(env: Env, task: Record<string, any>, diff: string): Promise<any> {
  // spec is API-supplied and flows into the model prompt: cap it (context + prompt-injection surface)
  const attempt = Number(task.attempt) || 1;
  const prevReview = task.review ? safeParse(task.review) : null;
  const remediation =
    attempt > 1
      ? `\n\n## 整改背景\n这是第 ${attempt} 次尝试。此前一轮被审查打回,原因:"${String(prevReview?.reason ?? "未通过").slice(0, 300)}"。当前 diff 可能包含对上一轮问题的修复(例如恢复被误改的文件),应结合任务规格评估其最终效果,不要仅因"改动较多"而拒绝。`
      : "";
  const prompt = [
    "你是 Relay 平台的代码审查 agent。对照任务规格审查 diff,输出严格的 JSON(不要 markdown 代码块,不要解释):",
    '{"verdict":"approve"|"reject","reason":"<一句话>","instructions":"<reject 时给编码 agent 的可执行整改指令,approve 时留空>"}',
    "",
    `## 任务规格\n${String(task.spec).slice(0, 4000)}`,
    remediation,
    "",
    `## Diff\n${diff.slice(0, 50000)}`,
  ].join("\n");
  try {
    const out: any = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
    });
    const parsed = parseReviewOutput(out);
    if (parsed.ok) {
      return {
        verdict: parsed.verdict,
        reason: parsed.reason,
        instructions: parsed.instructions,
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      };
    }
    // fail-closed: unparseable verdict suspends for a human, never auto-approves
    return {
      verdict: "needs_human",
      reason: "审查输出无法解析,已挂起等待人工裁决",
      instructions: "",
      model: "fallback",
      raw: parsed.raw,
    };
  } catch (e) {
    return {
      verdict: "needs_human",
      reason: `审查 agent 调用失败,已挂起等待人工裁决: ${String(e).slice(0, 200)}`,
      instructions: "",
      model: "fallback",
    };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ---- GET / — dashboard (public shell; data APIs below require the token)
    if (req.method === "GET" && (path === "/" || path === "/dashboard")) {
      return new Response(dashboardHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && path === "/healthz") return json({ ok: true, ts: now() });
    // Reads and task submission accept the (optional) submit token; everything else is admin-only.
    const readPath = path === "/events" || path === "/provenance" || path === "/tasks" || path.startsWith("/tasks/");
    const submitRoute = (req.method === "GET" && readPath) || (req.method === "POST" && path === "/tasks");
    if (!(await (submitRoute ? authSubmitter(req, env) : authed(req, env))))
      return json({ error: "unauthorized" }, 401);

    // ---- GET /events — global activity feed
    if (req.method === "GET" && path === "/events") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM events ORDER BY seq DESC LIMIT 120",
      ).all();
      return json({ events: results });
    }

    // ---- GET /provenance — who wrote what, and why
    if (req.method === "GET" && path === "/provenance") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM provenance ORDER BY created_at DESC LIMIT 120",
      ).all();
      return json({ provenance: results });
    }

    // ---- POST /bootstrap {repo?, description?} — also reports open tasks (attach guard)
    if (req.method === "POST" && path === "/bootstrap") {
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      const name = (body.repo as string) || env.RELAY_BASELINE;
      let remote: string;
      try {
        using repo = await env.ARTIFACTS.get(name);
        const info = await repo.info();
        remote = info.remote;
      } catch {
        const created = await env.ARTIFACTS.create(name, {
          description: (body.description as string) || `Relay baseline ${name}`,
        });
        remote = created.remote;
        await logEvent(env.DB, null, "baseline.created", { name });
      }
      using repo = await env.ARTIFACTS.get(name);
      const tok = await repo.createToken("write", 3600);
      const { results } = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE baseline_repo=? AND status NOT IN ('merged','failed')",
      ).bind(name).all<{ n: number }>();
      return json({ name, remote, token: tok.plaintext, expiresAt: tok.expiresAt, open_tasks: results[0]?.n ?? 0 });
    }

    // ---- POST /tasks {spec, baseline?, policy?, needs_human_review?}
    if (req.method === "POST" && path === "/tasks") {
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      const spec = (body.spec as string)?.trim();
      if (!spec) return json({ error: "spec is required" }, 400);
      const baseline = (body.baseline as string) || env.RELAY_BASELINE;

      // submit-token callers are rate-limited: every task forks an Artifacts repo.
      // Atomic upsert into a per-(minute, baseline) counter + the previous
      // bucket's total: a two-bucket sliding window, so a burst straddling a
      // minute boundary cannot split itself under the cap, and SQLite-side
      // serialization means concurrent requests cannot read a stale count.
      const openRow = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE baseline_repo=? AND status NOT IN ('merged','failed')",
      ).bind(baseline).first<{ n: number }>();
      const minute = Math.floor(Date.now() / 60_000);
      const prevRow = await env.DB.prepare(
        "SELECT n FROM rate_counters WHERE minute = ? AND baseline = ?",
      ).bind(minute - 1, baseline).first<{ n: number }>();
      const { results: bucketRows } = await env.DB.prepare(
        "INSERT INTO rate_counters (minute, baseline, n) VALUES (?, ?, 1) " +
          "ON CONFLICT(minute, baseline) DO UPDATE SET n = n + 1 RETURNING n",
      ).bind(minute, baseline).all<{ n: number }>();
      const gate = allowTaskCreation(
        openRow?.n ?? 0,
        (prevRow?.n ?? 0) + (bucketRows[0]?.n ?? 1),
        bearerOf(req) === `Bearer ${env.RELAY_TOKEN}`,
      );
      if (!gate.ok) return json({ error: gate.reason }, 429);

      const id = newTaskId();

      let workspaceRepo: string | null = null;
      let workspaceRemote: string | null = null;
      let forkBaseSha: string | null = null;
      try {
        using base = await env.ARTIFACTS.get(baseline);
        forkBaseSha = await baselineHead(env, baseline);
        const ws = await base.fork(workspaceName(id, 0), {
          defaultBranchOnly: true,
          description: `Relay workspace for task ${id}`,
        });
        workspaceRepo = ws.name;
        workspaceRemote = ws.remote;
      } catch (e) {
        await logEvent(env.DB, null, "task.fork_failed", { id, error: String(e) });
        return json({ error: `fork failed: ${String(e)}` }, 500);
      }

      const ts = now();
      const policy = body.policy ? JSON.stringify(normalizePolicy(body.policy)) : null;
      const needsHuman = body.needs_human_review === true ? 1 : 0;
      await env.DB.prepare(
        `INSERT INTO tasks (id, spec, baseline_repo, workspace_repo, workspace_remote, fork_base_sha, status, attempt, policy, needs_human_review, forked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
      )
        .bind(id, spec, baseline, workspaceRepo, workspaceRemote, forkBaseSha, policy, needsHuman, ts, ts, ts)
        .run();
      await logEvent(env.DB, id, "task.created", { spec, baseline, workspaceRepo, forkBaseSha, needs_human_review: needsHuman === 1, policy: policy ? JSON.parse(policy) : null });
      return json(await getTask(env.DB, id), 201);
    }

    // ---- GET /tasks?status= ("claimable" = queued | re_forked | failed | review_failed)
    if (req.method === "GET" && path === "/tasks") {
      const status = url.searchParams.get("status");
      const rows = status === "claimable"
        ? await env.DB.prepare(
            "SELECT * FROM tasks WHERE status IN ('queued','re_forked','failed','review_failed') ORDER BY created_at ASC LIMIT 100",
          ).all()
        : status
          ? await env.DB.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 100").bind(status).all()
          : await env.DB.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100").all();
      return json({ tasks: rows.results });
    }

    // ---- POST /schedule — the merge scheduler. One grant per call (serialized mainline).
    if (req.method === "POST" && path === "/schedule") {
      // recover stale 'merging' grants (merger crashed mid-execution)
      const staleCut = new Date(Date.now() - MERGE_GRANT_TIMEOUT_MS).toISOString();
      const rec = await env.DB.prepare(
        "UPDATE tasks SET status='awaiting_merge', updated_at=? WHERE status='merging' AND updated_at < ?",
      ).bind(now(), staleCut).run();
      if (rec.meta.changes) {
        await logEvent(env.DB, null, "merge.recovered", { count: rec.meta.changes });
      }

      // recover abandoned 'assigned' tasks (runner/agent died; write token long expired)
      const staleAssignedCut = new Date(Date.now() - ASSIGNED_TIMEOUT_MS).toISOString();
      const recA = await env.DB.prepare(
        "UPDATE tasks SET status='queued', updated_at=? WHERE status='assigned' AND updated_at < ?",
      ).bind(now(), staleAssignedCut).run();
      if (recA.meta.changes) {
        await logEvent(env.DB, null, "task.recovered_assigned", { count: recA.meta.changes });
      }

      // opportunistic: drop rate-counter buckets older than an hour
      await env.DB.prepare("DELETE FROM rate_counters WHERE minute < ?")
        .bind(Math.floor(Date.now() / 60_000) - 60).run();

      const { results: awaiting } = await env.DB.prepare(
        "SELECT * FROM tasks WHERE status = 'awaiting_merge' ORDER BY created_at ASC LIMIT 1",
      ).all<Record<string, any>>();
      if (!awaiting.length) return json({ grants: [], reforked: [] });

      const grants: any[] = [];
      const reforked: any[] = [];

      // touch-sets already on mainline
      const { results: mergedTasks } = await env.DB.prepare(
        "SELECT id, touch_set, merged_sha, merged_at FROM tasks WHERE status='merged' AND merged_at IS NOT NULL ORDER BY merged_at ASC LIMIT 200",
      ).all<Record<string, any>>();

      const task = awaiting[0];
      // head of THIS task's baseline (not the default one) — the ff/rebase
      // decision compares apples to apples; the merge executor still computes
      // the true merge-base itself, so this only steers grant mode.
      const head = await baselineHead(env, task.baseline_repo as string);
      const decision = decideMerge(task, mergedTasks, head);
      if (decision.action === "refork") {
        await reforkTask(env, task, `touch-set overlaps merged tasks: ${decision.overlaps.join(",")}`);
        reforked.push({ task_id: task.id, overlaps: decision.overlaps });
      } else {
        await env.DB.prepare("UPDATE tasks SET status='merging', updated_at=? WHERE id=?")
          .bind(now(), task.id).run();
        await logEvent(env.DB, task.id, "merge.granted", { mode: decision.action });
        grants.push({ task_id: task.id, mode: decision.action });
      }
      return json({ grants, reforked, baseline_head: head });
    }

    // ---- GET /merge/next — merger fetches the oldest 'merging' task + tokens
    if (req.method === "GET" && path === "/merge/next") {
      const task = await env.DB.prepare(
        "SELECT * FROM tasks WHERE status='merging' ORDER BY updated_at ASC LIMIT 1",
      ).first<Record<string, any>>();
      if (!task) return json({ grant: null });
      using wsRepo = await env.ARTIFACTS.get(task.workspace_repo as string);
      using baseRepo = await env.ARTIFACTS.get(task.baseline_repo as string);
      const wsTok = await wsRepo.createToken("read", 300);
      const baseTok = await baseRepo.createToken("write", 300);
      return json({
        grant: {
          task_id: task.id,
          workspace_remote: task.workspace_remote,
          workspace_head: task.head_sha,
          fork_base_sha: task.fork_base_sha,
          baseline_remote: (await baseRepo.info()).remote,
          read_token: wsTok.plaintext,
          baseline_token: baseTok.plaintext,
          provenance: task.attempt,
        },
      });
    }

    // ---- /tasks/:id/*
    const m = /^\/tasks\/([a-z0-9_]+)(\/[a-z_]+)?$/.exec(path);
    if (!m) return json({ error: "not found" }, 404);
    const id = m[1];
    const action = m[2]?.slice(1);

    if (req.method === "GET" && !action) {
      const task = await getTask(env.DB, id);
      if (!task) return json({ error: "task not found" }, 404);
      const events = await env.DB.prepare(
        "SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT 50",
      ).bind(id).all();
      return json({ task, events: events.results });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, any>;

    // ---- POST /tasks/:id/claim {agent}
    if (req.method === "POST" && action === "claim") {
      const agent = (body.agent as string)?.trim();
      if (!agent) return json({ error: "agent is required" }, 400);
      // server-side pre-claim status decides remediation context — never trust the client
      const existing = await getTask(env.DB, id);
      if (!existing) return json({ error: "task not found" }, 404);
      const res = await env.DB.prepare(
        `UPDATE tasks SET status='assigned', assigned_agent=?, attempt=attempt+1, updated_at=?
         WHERE id=? AND status IN ('queued','re_forked','failed','review_failed')`,
      ).bind(agent, now(), id).run();
      if (!res.meta.changes) return json({ error: "task not claimable" }, 409);
      const task = await getTask(env.DB, id);
      if (!task) return json({ error: "task vanished after claim" }, 500);
      const fromStatus = existing.status as string;
      await logEvent(env.DB, id, "task.claimed", { agent, attempt: task.attempt, from: fromStatus });
      using ws = await env.ARTIFACTS.get(task.workspace_repo as string);
      const tok = await ws.createToken("write", 2700);
      const review = task.review ? JSON.parse(task.review) : null;
      return json({
        id,
        spec: task.spec,
        baseline_repo: task.baseline_repo,
        workspace_repo: task.workspace_repo,
        workspace_remote: task.workspace_remote,
        fork_base_sha: task.fork_base_sha,
        attempt: task.attempt,
        write_token: tok.plaintext,
        token_expires_at: tok.expiresAt,
        // remediation inputs: agent reads these to redo/repair
        review: fromStatus === "review_failed" && review
          ? { verdict: review.verdict, reason: review.reason, instructions: review.instructions }
          : null,
        previous_touch_set:
          fromStatus === "review_failed" || fromStatus === "re_forked"
            ? touchSetOf(existing)
            : null,
      });
    }

    // ---- POST /tasks/:id/report — runner reports; kernel runs the review agent inline.
    if (req.method === "POST" && action === "report") {
      const task = await getTask(env.DB, id);
      if (!task) return json({ error: "task not found" }, 404);
      const result = body.result as string;
      // State guard: reports only transition valid predecessors, never rewind history.
      const okFrom = result === "conflict" ? ["merging"] : ["assigned", "pushed"];
      if (!okFrom.includes(task.status as string)) {
        return json(
          { error: `report '${result}' not accepted for task in status '${task.status}'` },
          409,
        );
      }
      const ts = now();
      if (result === "pushed") {
        // touch_set is runner-reported; cap it so a hostile runner can't bloat D1
        const touchSet = Array.isArray(body.touch_set) ? body.touch_set.map(String).slice(0, 500) : [];
        const diff = typeof body.diff === "string" ? body.diff : "";
        await env.DB.prepare(
          `UPDATE tasks SET status='pushed', touch_set=?, head_sha=?, checks=?, updated_at=? WHERE id=?`,
        ).bind(JSON.stringify(touchSet), body.head_sha ?? null, body.checks ? JSON.stringify(body.checks).slice(0, 8000) : null, ts, id).run();
        if (body.provenance) {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO provenance (repo, commit_sha, task_id, agent, model, note, created_at) VALUES (?,?,?,?,?,?,?)`,
          )
            .bind(task.workspace_repo, body.head_sha ?? "unknown", id,
              body.provenance.agent ?? task.assigned_agent, body.provenance.model ?? null,
              JSON.stringify(body.provenance), ts)
            .run();
        }
        await logEvent(env.DB, id, "task.pushed", {
          head_sha: body.head_sha, touch_set: touchSet, agent: task.assigned_agent,
        });

        // ---- trust gate 1: deterministic policy (deny/allow/max_files/max_diff) — no AI involved
        const policy = applyPolicy(safeParse(task.policy), touchSet, diff.length);
        if (!policy.ok) {
          const verdict = { verdict: "reject", reason: `策略拦截: ${policy.violations.map((v) => v.detail).join("; ").slice(0, 300)}`, instructions: policy.instructions, model: "policy" };
          await env.DB.prepare(`UPDATE tasks SET status='review_failed', review=?, updated_at=? WHERE id=?`)
            .bind(JSON.stringify(verdict), now(), id).run();
          await logEvent(env.DB, id, "review.policy_rejected", { violations: policy.violations });
          return json({ ...(await getTask(env.DB, id)), review: verdict });
        }

        // ---- trust gate 2: deterministic local checks (tests/lint run by the runner against base scripts)
        const checks = evalChecks(body.checks);
        if (!checks.ok) {
          const verdict = { verdict: "reject", reason: `本地检查未通过: ${checks.failed.join(", ")}`, instructions: checks.instructions, model: "checks" };
          await env.DB.prepare(`UPDATE tasks SET status='review_failed', review=?, updated_at=? WHERE id=?`)
            .bind(JSON.stringify(verdict), now(), id).run();
          await logEvent(env.DB, id, "review.checks_failed", { failed: checks.failed });
          return json({ ...(await getTask(env.DB, id)), review: verdict });
        }

        // ---- trust gate 3: review agent (fail-closed — errors suspend, never pass)
        const verdict = await reviewTask(env, task, diff);
        const nextStatus =
          verdict.verdict === "approve"
            ? task.needs_human_review
              ? "needs_human"
              : "awaiting_merge"
            : verdict.verdict === "needs_human"
              ? "needs_human"
              : "review_failed";
        await env.DB.prepare(
          `UPDATE tasks SET status=?, review=?, updated_at=? WHERE id=?`,
        ).bind(nextStatus, JSON.stringify(verdict), now(), id).run();
        await logEvent(env.DB, id,
          verdict.verdict === "approve" ? "review.approved"
            : verdict.verdict === "needs_human" ? "review.held"
              : "review.rejected", verdict);
        return json({ ...(await getTask(env.DB, id)), review: verdict });
      }

      if (result === "conflict") {
        // rebase conflict during merge → re-fork, agent redoes on new baseline
        await reforkTask(env, task, `rebase conflict during merge: ${body.detail ?? ""}`.slice(0, 300));
        return json(await getTask(env.DB, id));
      }

      await env.DB.prepare(`UPDATE tasks SET status='failed', updated_at=? WHERE id=?`).bind(ts, id).run();
      await logEvent(env.DB, id, "task.failed", { detail: body.detail ?? null });
      return json(await getTask(env.DB, id));
    }

    // ---- POST /tasks/:id/merged {merged_sha} — merger reports success
    if (req.method === "POST" && action === "merged") {
      const ts = now();
      await env.DB.prepare(
        `UPDATE tasks SET status='merged', merged_sha=?, merged_at=?, updated_at=? WHERE id=?`,
      ).bind(body.merged_sha ?? null, ts, ts, id).run();
      await logEvent(env.DB, id, "mainline.merged", {
        merged_sha: body.merged_sha ?? null,
        rebased: !!body.rebased,
        touch_set: body.touch_set ?? null,
      });
      return json(await getTask(env.DB, id));
    }

    // ---- POST /tasks/:id/human_review {decision: approve|reject, note?} — resolve a suspended task (admin)
    if (req.method === "POST" && action === "human_review") {
      const task = await getTask(env.DB, id);
      if (!task) return json({ error: "task not found" }, 404);
      if (task.status !== "needs_human")
        return json({ error: `human_review only applies to needs_human tasks, task is '${task.status}'` }, 409);
      const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
      if (!decision) return json({ error: "decision must be 'approve' or 'reject'" }, 400);
      const note = String(body.note ?? "").slice(0, 300);
      const prev = safeParse(task.review) ?? {};
      const review = {
        ...prev,
        verdict: decision,
        reason: `人工${decision === "approve" ? "放行" : "打回"}${note ? `:${note}` : ""}`,
        instructions: decision === "reject" ? note || "人工打回,请对照任务规格重做" : "",
        model: "human",
        human: true,
      };
      await env.DB.prepare(
        `UPDATE tasks SET status=?, review=?, updated_at=? WHERE id=?`,
      ).bind(decision === "approve" ? "awaiting_merge" : "review_failed", JSON.stringify(review), now(), id).run();
      await logEvent(env.DB, id, decision === "approve" ? "review.human_approved" : "review.human_rejected", { note });
      return json({ ...(await getTask(env.DB, id)), review });
    }

    return json({ error: "not found" }, 404);
  },

  // ---- Queue consumer: Artifacts event subscriptions land here.
  async queue(batch: MessageBatch<{ type: string; source: any; payload: any }>, env: Env) {
    for (const msg of batch.messages) {
      try {
        const evt = msg.body;
        if (evt?.type === "cf.artifacts.repo.pushed") {
          const repo = evt.source?.repoName as string | undefined;
          const parsed = repo ? parseWorkspace(repo) : null;
          if (parsed) {
            const task = await getTask(env.DB, parsed.taskId);
            if (task && task.status === "assigned") {
              await env.DB.prepare(`UPDATE tasks SET status='pushed', head_sha=?, updated_at=? WHERE id=?`)
                .bind(evt.payload.after ?? null, now(), parsed.taskId).run();
            }
            await logEvent(env.DB, parsed.taskId, "workspace.pushed", {
              repo, after: evt.payload.after, commits: evt.payload.totalCommitsCount,
            });
          } else {
            await logEvent(env.DB, null, "repo.pushed", { repo, after: evt.payload.after });
          }
        }
        msg.ack();
      } catch (e) {
        await logEvent(env.DB, null, "queue.error", { error: String(e) });
        msg.retry();
      }
    }
  },
};
