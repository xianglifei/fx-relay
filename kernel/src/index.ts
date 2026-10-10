/**
 * relay-kernel — a Git collaboration kernel for AI agents.
 * Control plane: task birth (fork-per-task), claim, report, provenance index.
 * State split: D1 for scheduling, git notes for memory.
 */

export interface Env {
  ARTIFACTS: Artifacts;
  DB: D1Database;
  RELAY_TOKEN: string;
  RELAY_NAMESPACE: string;
  RELAY_BASELINE: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const now = () => new Date().toISOString();
const newTaskId = () =>
  "tsk_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);

async function logEvent(
  db: D1Database,
  taskId: string | null,
  type: string,
  payload: unknown,
) {
  await db
    .prepare(
      "INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(taskId, type, JSON.stringify(payload), now())
    .run();
}

async function getTask(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
}

/** Workspace repo names encode the task: task-<id without prefix>-a<attempt>. */
function workspaceName(taskId: string, attempt: number) {
  return `task-${taskId.replace(/^tsk_/, "")}-a${attempt}`;
}
function parseWorkspace(repo: string) {
  const m = /^task-([a-z0-9]+)-a(\d+)$/.exec(repo);
  if (!m) return null;
  return { taskId: "tsk_" + m[1], attempt: Number(m[2]) };
}

async function authed(req: Request, env: Env): Promise<boolean> {
  const hdr = req.headers.get("authorization") ?? "";
  return hdr === `Bearer ${env.RELAY_TOKEN}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") {
      return json({ ok: true, ts: now() });
    }
    if (!(await authed(req, env))) {
      return json({ error: "unauthorized" }, 401);
    }

    // ---- POST /bootstrap {repo?, description?} — ensure a repo exists, get remote + short write token.
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

    // ---- POST /tasks {spec, baseline?} — task is born: fork workspace from baseline.
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
        const head = await base.log({ limit: 1 });
        forkBaseSha = head[0]?.id ?? null;
        const ws = await base.fork(workspaceName(id, 0), {
          defaultBranchOnly: true,
          description: `Relay workspace for task ${id}`,
        });
        workspaceRepo = ws.name;
        workspaceRemote = ws.remote;
      } catch (e) {
        await logEvent(env.DB, null, "task.fork_failed", {
          id,
          error: String(e),
        });
        return json({ error: `fork failed: ${String(e)}` }, 500);
      }

      const ts = now();
      await env.DB.prepare(
        `INSERT INTO tasks (id, spec, baseline_repo, workspace_repo, workspace_remote, fork_base_sha, status, attempt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      )
        .bind(id, spec, baseline, workspaceRepo, workspaceRemote, forkBaseSha, ts, ts)
        .run();
      await logEvent(env.DB, id, "task.created", {
        spec,
        baseline,
        workspaceRepo,
        forkBaseSha,
      });
      return json(await getTask(env.DB, id), 201);
    }

    // ---- GET /tasks?status=  ("claimable" = queued | re_forked | failed)
    if (req.method === "GET" && path === "/tasks") {
      const status = url.searchParams.get("status");
      const claimable = status === "claimable";
      const rows = claimable
        ? await env.DB.prepare(
            "SELECT * FROM tasks WHERE status IN ('queued','re_forked','failed') ORDER BY created_at ASC LIMIT 100",
          ).all()
        : status
          ? await env.DB.prepare(
              "SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 100",
            ).bind(status).all()
          : await env.DB.prepare(
              "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100",
            ).all();
      return json({ tasks: rows.results });
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

    // ---- POST /tasks/:id/claim {agent} — atomically assign; mint a scoped write token.
    if (req.method === "POST" && action === "claim") {
      const agent = (body.agent as string)?.trim();
      if (!agent) return json({ error: "agent is required" }, 400);
      const ts = now();
      const res = await env.DB.prepare(
        `UPDATE tasks SET status = 'assigned', assigned_agent = ?, attempt = attempt + 1, updated_at = ?
         WHERE id = ? AND status IN ('queued', 're_forked', 'failed')`,
      )
        .bind(agent, ts, id)
        .run();
      if (!res.meta.changes) return json({ error: "task not claimable" }, 409);
      const task = await getTask(env.DB, id);
      await logEvent(env.DB, id, "task.claimed", { agent, attempt: task.attempt });
      using ws = await env.ARTIFACTS.get(task.workspace_repo as string);
      const tok = await ws.createToken("write", 2700);
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
      });
    }

    // ---- POST /tasks/:id/token {agent} — refresh an expiring write token.
    if (req.method === "POST" && action === "token") {
      const task = await getTask(env.DB, id);
      if (!task) return json({ error: "task not found" }, 404);
      if (body.agent !== task.assigned_agent)
        return json({ error: "not the assigned agent" }, 403);
      using ws = await env.ARTIFACTS.get(task.workspace_repo as string);
      const tok = await ws.createToken("write", 2700);
      return json({ write_token: tok.plaintext, token_expires_at: tok.expiresAt });
    }

    // ---- POST /tasks/:id/report — runner reports outcome; carries touch-set + provenance.
    if (req.method === "POST" && action === "report") {
      const task = await getTask(env.DB, id);
      if (!task) return json({ error: "task not found" }, 404);
      const result = body.result as string;
      const ts = now();
      if (result === "pushed") {
        await env.DB.prepare(
          `UPDATE tasks SET status = 'pushed', touch_set = ?, head_sha = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(
            JSON.stringify(body.touch_set ?? []),
            body.head_sha ?? null,
            ts,
            id,
          )
          .run();
        // Provenance: runner relays the git-notes payload so the platform can index it.
        if (body.provenance) {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO provenance (repo, commit_sha, task_id, agent, model, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              task.workspace_repo,
              body.head_sha ?? "unknown",
              id,
              body.provenance.agent ?? task.assigned_agent,
              body.provenance.model ?? null,
              JSON.stringify(body.provenance),
              ts,
            )
            .run();
        }
        await logEvent(env.DB, id, "task.pushed", {
          head_sha: body.head_sha,
          touch_set: body.touch_set,
          agent: task.assigned_agent,
        });
      } else {
        await env.DB.prepare(
          `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
        )
          .bind(ts, id)
          .run();
        await logEvent(env.DB, id, "task.failed", { detail: body.detail ?? null });
      }
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
              await env.DB.prepare(
                `UPDATE tasks SET status = 'pushed', head_sha = ?, updated_at = ? WHERE id = ?`,
              )
                .bind(evt.payload.after ?? null, now(), parsed.taskId)
                .run();
            }
            await logEvent(env.DB, parsed.taskId, "workspace.pushed", {
              repo,
              after: evt.payload.after,
              commits: evt.payload.totalCommitsCount,
            });
          } else {
            await logEvent(env.DB, null, "repo.pushed", {
              repo,
              after: evt.payload.after,
            });
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
