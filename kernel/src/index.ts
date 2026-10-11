/**
 * relay-kernel — a Git collaboration kernel for AI agents.
 *
 * Day 2 control plane:
 *  - task birth: fork-per-task, short repo-scoped tokens
 *  - review agent: Workers AI structured verdict (approve/reject + machine instructions)
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
  RELAY_NAMESPACE: string;
  RELAY_BASELINE: string;
}

import { dashboardHtml } from "./dashboard";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const now = () => new Date().toISOString();
const newTaskId = () => "tsk_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);

async function logEvent(db: D1Database, taskId: string | null, type: string, payload: unknown) {
  await db
    .prepare("INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
    .bind(taskId, type, JSON.stringify(payload), now())
    .run();
}

async function getTask(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Record<string, any>>();
}

const touchSetOf = (task: Record<string, any>): string[] => {
  try { return JSON.parse(task.touch_set ?? "[]"); } catch { return []; }
};
const intersects = (a: string[], b: string[]) => a.some((f) => b.includes(f));

function workspaceName(taskId: string, attempt: number) {
  return `task-${taskId.replace(/^tsk_/, "")}-a${attempt}`;
}
function parseWorkspace(repo: string) {
  const m = /^task-([a-z0-9]+)-a(\d+)$/.exec(repo);
  return m ? { taskId: "tsk_" + m[1], attempt: Number(m[2]) } : null;
}

async function authed(req: Request, env: Env): Promise<boolean> {
  return (req.headers.get("authorization") ?? "") === `Bearer ${env.RELAY_TOKEN}`;
}

/** Current baseline head sha (null if indexing lags). */
async function baselineHead(env: Env, baseline: string): Promise<string | null> {
  try {
    using repo = await env.ARTIFACTS.get(baseline);
    const head = await repo.log({ limit: 1 });
    return head[0]?.id ?? null;
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
    .bind(ws.name, ws.remote, head[0]?.id ?? null, attempt, now(), now(), id)
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
  const prompt = [
    "你是 Relay 平台的代码审查 agent。对照任务规格审查 diff,输出严格的 JSON(不要 markdown 代码块,不要解释):",
    '{"verdict":"approve"|"reject","reason":"<一句话>","instructions":"<reject 时给编码 agent 的可执行整改指令,approve 时留空>"}',
    "",
    `## 任务规格\n${task.spec}`,
    "",
    `## Diff\n${diff.slice(0, 50000)}`,
  ].join("\n");
  try {
    const out: any = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 600,
    });
    // Workers AI return shapes vary by model/route: string | {response} | content-block arrays.
    const flatten = (v: any): string => {
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return v.map((b) => (typeof b === "string" ? b : b?.text ?? b?.response ?? "")).join("");
      if (typeof v === "object") {
        if (Array.isArray(v.choices)) return flatten(v.choices[0]?.message?.content ?? "");
        return flatten(v.response ?? v.result ?? v.text ?? "");
      }
      return String(v);
    };
    const text = flatten(out) || JSON.stringify(out ?? "");
    const m = /\{[\s\S]*\}/.exec(text);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (parsed?.verdict) {
      return {
        verdict: parsed.verdict === "approve" ? "approve" : "reject",
        reason: String(parsed.reason ?? "").slice(0, 1000),
        instructions: String(parsed.instructions ?? "").slice(0, 1000),
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      };
    }
    return { verdict: "approve", reason: "review parse failed, auto-approved", instructions: "", model: "fallback", raw: text.slice(0, 400) };
  } catch (e) {
    return { verdict: "approve", reason: `review agent error, auto-approved: ${String(e).slice(0, 200)}`, instructions: "", model: "fallback" };
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
    if (!(await authed(req, env))) return json({ error: "unauthorized" }, 401);

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

    // ---- POST /bootstrap {repo?, description?}
    if (req.method === "POST" && path === "/bootstrap") {
      const body = await req.json().catch(() => ({}));
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
      return json({ name, remote, token: tok.plaintext, expiresAt: tok.expiresAt });
    }

    // ---- POST /tasks {spec, baseline?}
    if (req.method === "POST" && path === "/tasks") {
      const body = await req.json().catch(() => ({}));
      const spec = (body.spec as string)?.trim();
      if (!spec) return json({ error: "spec is required" }, 400);
      const baseline = (body.baseline as string) || env.RELAY_BASELINE;
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
      await env.DB.prepare(
        `INSERT INTO tasks (id, spec, baseline_repo, workspace_repo, workspace_remote, fork_base_sha, status, attempt, forked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
        .bind(id, spec, baseline, workspaceRepo, workspaceRemote, forkBaseSha, ts, ts, ts)
        .run();
      await logEvent(env.DB, id, "task.created", { spec, baseline, workspaceRepo, forkBaseSha });
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
      const { results: awaiting } = await env.DB.prepare(
        "SELECT * FROM tasks WHERE status = 'awaiting_merge' ORDER BY created_at ASC LIMIT 1",
      ).all<Record<string, any>>();
      if (!awaiting.length) return json({ grants: [], reforked: [] });

      const head = await baselineHead(env, env.RELAY_BASELINE);
      const grants: any[] = [];
      const reforked: any[] = [];

      // touch-sets already on mainline — only tasks merged AFTER this workspace
      // was forked can conflict with it (temporal rule, converges by construction)
      const { results: mergedTasks } = await env.DB.prepare(
        "SELECT id, touch_set, merged_sha, merged_at FROM tasks WHERE status='merged' AND merged_at IS NOT NULL ORDER BY merged_at ASC LIMIT 200",
      ).all<Record<string, any>>();

      for (const task of awaiting) {
        const mine = touchSetOf(task);
        const mergedSince = mergedTasks.filter((mt) => mt.merged_at > task.forked_at);
        const overlap = mergedSince
          .filter((mt) => intersects(mine, touchSetOf(mt)))
          .map((mt) => mt.id);

        const ffable = !head || !task.fork_base_sha || head === task.fork_base_sha;
        if (overlap.length > 0) {
          // conflict course: re-fork on current baseline, agent redoes.
          // Runs FIRST — touch-set overlap with merged work is a hard signal,
          // even when the baseline head snapshot is unavailable.
          await reforkTask(env, task, `touch-set overlaps merged tasks: ${overlap.join(",")}`);
          reforked.push({ task_id: task.id, overlaps: overlap });
        } else if (ffable) {
          // linear mainline untouched since fork → plain fast-forward
          await env.DB.prepare("UPDATE tasks SET status='merging', updated_at=? WHERE id=?")
            .bind(now(), task.id).run();
          await logEvent(env.DB, task.id, "merge.granted", { mode: "fast_forward" });
          grants.push({ task_id: task.id, mode: "fast_forward" });
        } else {
          // baseline moved but files disjoint → runner replays commits
          await env.DB.prepare("UPDATE tasks SET status='merging', updated_at=? WHERE id=?")
            .bind(now(), task.id).run();
          await logEvent(env.DB, task.id, "merge.granted", { mode: "rebase" });
          grants.push({ task_id: task.id, mode: "rebase" });
        }
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
      const wsTok = await wsRepo.createToken("read", 1800);
      const baseTok = await baseRepo.createToken("write", 1800);
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

    const body = await req.json().catch(() => ({}));

    // ---- POST /tasks/:id/claim {agent}
    if (req.method === "POST" && action === "claim") {
      const agent = (body.agent as string)?.trim();
      if (!agent) return json({ error: "agent is required" }, 400);
      const res = await env.DB.prepare(
        `UPDATE tasks SET status='assigned', assigned_agent=?, attempt=attempt+1, updated_at=?
         WHERE id=? AND status IN ('queued','re_forked','failed','review_failed')`,
      ).bind(agent, now(), id).run();
      if (!res.meta.changes) return json({ error: "task not claimable" }, 409);
      const task = await getTask(env.DB, id);
      await logEvent(env.DB, id, "task.claimed", { agent, attempt: task.attempt, from: body.from_status ?? null });
      using ws = await env.ARTIFACTS.get(task.workspace_repo as string);
      const tok = await ws.createToken("write", 2700);
      const wasRedo = body.from_status === "review_failed" || body.from_status === "re_forked";
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
        review: body.from_status === "review_failed" && review
          ? { verdict: review.verdict, reason: review.reason, instructions: review.instructions }
          : null,
        previous_touch_set: wasRedo ? touchSetOf(task) : null,
      });
    }

    // ---- POST /tasks/:id/report — runner reports; kernel runs the review agent inline.
    if (req.method === "POST" && action === "report") {
      const task = await getTask(env.DB, id);
      if (!task) return json({ error: "task not found" }, 404);
      const result = body.result as string;
      const ts = now();
      if (result === "pushed") {
        await env.DB.prepare(
          `UPDATE tasks SET status='pushed', touch_set=?, head_sha=?, updated_at=? WHERE id=?`,
        ).bind(JSON.stringify(body.touch_set ?? []), body.head_sha ?? null, ts, id).run();
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
          head_sha: body.head_sha, touch_set: body.touch_set, agent: task.assigned_agent,
        });

        // ---- review agent, inline
        const verdict = await reviewTask(env, task, body.diff ?? "");
        await env.DB.prepare(
          `UPDATE tasks SET status=?, review=?, updated_at=? WHERE id=?`,
        ).bind(
          verdict.verdict === "approve" ? "awaiting_merge" : "review_failed",
          JSON.stringify(verdict), now(), id,
        ).run();
        await logEvent(env.DB, id, verdict.verdict === "approve" ? "review.approved" : "review.rejected", verdict);
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
