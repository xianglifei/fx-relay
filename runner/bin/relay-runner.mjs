#!/usr/bin/env node
/**
 * relay-runner — the execution plane.
 *
 * Commands:
 *   relay-runner seed  --dir ../baseline-template [--repo demo-app]
 *   relay-runner work  --agent zcode|claude|codebuddy|dsh [--once]
 *   relay-runner merge [--once]          # merge-grant executor (rebase/ff onto mainline)
 *   relay-runner config <url> <token>
 *
 * The runner owns commit, notes and push — the agent only edits files.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { adapters } from "../adapters.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const LOCAL_CFG = path.join(ROOT, "..", "relay.local.json");

async function cfg() {
  let file = {};
  if (existsSync(LOCAL_CFG)) file = JSON.parse(await readFile(LOCAL_CFG, "utf8"));
  return {
    url: process.env.RELAY_URL || file.url,
    token: process.env.RELAY_TOKEN || file.token,
  };
}

async function api(pathname, init = {}) {
  const { url, token } = await cfg();
  if (!url || !token) throw new Error("missing RELAY_URL / RELAY_TOKEN (run `relay-runner config`)");
  const res = await fetch(url.replace(/\/$/, "") + pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${pathname}: ${JSON.stringify(body)}`);
  return body;
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
    p.on("error", (err) => resolve({ code: -1, out: String(err) }));
  });
}

const git = (cwd, ...args) => sh("git", ["-C", cwd, ...args]);
const gitAuth = (cwd, token, ...args) =>
  sh("git", ["-C", cwd, "-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args]);

function buildPrompt(task) {
  const sections = [
    "你是被 Relay 平台派来的编码 agent,在一个独立工作区里完成一项编码任务。",
    "",
    `## 任务规格\n${task.spec}`,
  ];
  if (task.review?.instructions) {
    sections.push(
      "",
      "## 上一轮审查未通过,整改指令(优先级最高)",
      `审查意见:${task.review.reason || "无"}`,
      `整改指令:${task.review.instructions}`,
      "请在现有代码基础上修复以上问题。",
    );
  }
  if (task.attempt > 1) {
    sections.push(
      "",
      "## 重做说明",
      "这是一个新的工作区(此前的改动因与主线冲突被平台调度重做)。请在当前基线上重新完成任务规格;",
      task.previous_touch_set?.length
        ? `此前一轮改动涉及这些文件,可作为范围参考:${task.previous_touch_set.join(", ")}。`
        : "",
    );
  }
  sections.push(
    "",
    "## 规则",
    "1. 阅读仓库根目录的 AGENTS.md 并遵守其中的项目约定;",
    "2. 只修改与任务相关的文件,保持改动最小;",
    "3. 完成后用 git 提交所有改动,提交信息格式:`task: <一句话摘要>`;",
    "4. 不要执行 git push(push 由 runner 负责),不要改动 git 配置或远程地址;",
    "5. 如果任务无法完成,在仓库根目录写一个 RELAY_FAILURE.md 说明原因。",
  );
  return sections.filter((s) => s !== "").join("\n");
}

async function runAgent(adapter, prompt, workdir) {
  const a = adapters[adapter];
  if (!a) throw new Error(`unknown agent adapter: ${adapter}`);
  console.log(`[runner] spawning ${a.label} ...`);
  const started = Date.now();
  const res = await new Promise((resolve) => {
    const p = spawn(a.cmd, a.args(prompt), { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve({ code: -1, out: out + "\n[runner] agent timed out" });
    }, a.timeoutMs);
    p.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d.length < 4096 ? d : "");
    });
    p.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d.length < 4096 ? d : "");
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    p.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(err) });
    });
  });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`[runner] ${adapter} exited code=${res.code} in ${secs}s`);
  return res;
}

async function workOnce(agent) {
  const { tasks } = await api("/tasks?status=claimable");
  if (!tasks?.length) return false;
  // oldest first; a concurrent runner may win a claim (409) — try the next one
  for (const target of tasks) {
    const task = await api(`/tasks/${target.id}/claim`, {
      method: "POST",
      body: JSON.stringify({ agent, from_status: target.status }),
    }).catch(() => null);
    if (!task) continue;
    await executeTask(task, target.status, agent);
    return true;
  }
  return true; // all lost to races; caller loops
}

async function executeTask(task, fromStatus, agent) {
  const target = { id: task.id, status: fromStatus };
  console.log(`[runner] claimed ${task.id} (attempt ${task.attempt}, from ${fromStatus})`);
  console.log(`[runner] spec: ${task.spec}`);

  const workdir = await mkdtemp(path.join(os.tmpdir(), `relay-${task.id}-`));
  try {
    const clone = await gitAuth(workdir, task.write_token, "clone", task.workspace_remote, "repo");
    if (clone.code !== 0) throw new Error(`clone failed: ${clone.out}`);
    const repo = path.join(workdir, "repo");

    const baseSha = (await git(repo, "rev-parse", "HEAD")).out.trim() || task.fork_base_sha;
    if (!baseSha) throw new Error("cannot determine fork base sha");

    await runAgent(agent, buildPrompt(task), repo);

    await git(repo, "add", "-A");
    const st = await git(repo, "status", "--porcelain");
    if (st.out.trim()) {
      await git(repo, "commit", "-m", "task: agent follow-up commit of remaining changes");
    }

    const headSha = (await git(repo, "rev-parse", "HEAD")).out.trim();
    if (headSha === baseSha) {
      const failNote = existsSync(path.join(repo, "RELAY_FAILURE.md"))
        ? await readFile(path.join(repo, "RELAY_FAILURE.md"), "utf8")
        : "agent produced no commits";
      await api(`/tasks/${task.id}/report`, {
        method: "POST",
        body: JSON.stringify({ result: "failed", detail: failNote.slice(0, 2000) }),
      });
      console.log(`[runner] ${task.id}: failed — ${failNote.slice(0, 200)}`);
      return true;
    }

    // Provenance as git notes: the repo IS the memory.
    const provenance = {
      task_id: task.id,
      agent,
      model: adapters[agent].label,
      spec_digest: task.spec.slice(0, 200),
      fork_base: baseSha,
      attempt: task.attempt,
      remediation: task.review?.instructions ? true : false,
      runner: "relay-runner/0.2",
      pushed_at: new Date().toISOString(),
    };
    await git(repo, "notes", "add", "-f", "-m", JSON.stringify(provenance), headSha);

    const push = await gitAuth(repo, task.write_token, "push", "origin", "HEAD:main");
    if (push.code !== 0) throw new Error(`push failed: ${push.out}`);
    await gitAuth(repo, task.write_token, "push", "origin", "+refs/notes/commits");

    const diff = await git(repo, "diff", "--name-only", `${baseSha}..HEAD`);
    const touchSet = diff.out.split("\n").map((s) => s.trim()).filter(Boolean);
    const patch = (await git(repo, "diff", `${baseSha}..HEAD`)).out.slice(0, 60000);

    const report = await api(`/tasks/${task.id}/report`, {
      method: "POST",
      body: JSON.stringify({
        result: "pushed",
        head_sha: headSha,
        touch_set: touchSet,
        diff: patch,
        provenance,
      }),
    });
    const review = report.review;
    console.log(
      `[runner] ${task.id}: pushed ${headSha.slice(0, 8)} touch=${touchSet.length} files | ` +
      `review=${review?.verdict ?? "?"}${review?.reason ? ` (${review.reason})` : ""}`,
    );
    return true;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Merge-grant executor: baseline stays linear. Fast-forward when possible,
 * otherwise cherry-pick the task's commits onto the new head. Conflicts are
 * reported so the kernel re-forks and an agent redoes the task.
 */
async function mergeOnce() {
  const { grant } = await api("/merge/next");
  if (!grant) return false;
  const { task_id, workspace_remote, baseline_remote, read_token, baseline_token } = grant;
  console.log(`[merge] executing grant for ${task_id} (${grant.mode ?? "auto"})`);

  const workdir = await mkdtemp(path.join(os.tmpdir(), `relay-merge-${task_id}-`));
  try {
    const clone = await gitAuth(workdir, baseline_token, "clone", baseline_remote, "base");
    if (clone.code !== 0) throw new Error(`baseline clone failed: ${clone.out}`);
    const base = path.join(workdir, "base");
    await git(base, "config", "user.email", "merger@relay.local");
    await git(base, "config", "user.name", "Relay Merger");

    const fetch = await gitAuth(base, read_token, "fetch", workspace_remote, "main");
    if (fetch.code !== 0) throw new Error(`workspace fetch failed: ${fetch.out}`);
    const wsHead = (await git(base, "rev-parse", "FETCH_HEAD")).out.trim();
    const baseHead = (await git(base, "rev-parse", "HEAD")).out.trim();

    let rebased = false;
    let mergeTarget = wsHead;

    // Fork point computed at merge time — immune to kernel-side log lag.
    const mb = await git(base, "merge-base", baseHead, wsHead);
    const mergeBase = mb.out.trim();
    if (mb.code !== 0 || !mergeBase) throw new Error(`merge-base failed: ${mb.out}`);

    if (mergeBase !== baseHead) {
      // mainline moved → replay the task's commits onto the new head
      rebased = true;
      const cp = await git(base, "cherry-pick", `${mergeBase}..${wsHead}`);
      if (cp.code !== 0) {
        await git(base, "cherry-pick", "--abort").catch(() => {});
        await api(`/tasks/${task_id}/report`, {
          method: "POST",
          body: JSON.stringify({ result: "conflict", detail: cp.out.slice(0, 1500) }),
        });
        console.log(`[merge] ${task_id}: cherry-pick conflict → re-fork requested`);
        return true;
      }
      mergeTarget = (await git(base, "rev-parse", "HEAD")).out.trim();
    } else {
      // plain fast-forward
      const ff = await git(base, "merge", "--ff-only", wsHead);
      if (ff.code !== 0) {
        await api(`/tasks/${task_id}/report`, {
          method: "POST",
          body: JSON.stringify({ result: "conflict", detail: ff.out.slice(0, 1500) }),
        });
        console.log(`[merge] ${task_id}: not fast-forwardable → re-fork requested`);
        return true;
      }
    }

    // re-attach provenance note on the (possibly rewritten) tip
    const noteSrc = await git(base, "notes", "--ref=commits", "show", wsHead).catch(() => ({ code: 1, out: "" }));
    if (noteSrc.code === 0 && noteSrc.out.trim()) {
      await git(base, "notes", "add", "-f", "-m", noteSrc.out.trim(), mergeTarget);
    }

    const push = await gitAuth(base, baseline_token, "push", "origin", `HEAD:main`);
    if (push.code !== 0) throw new Error(`baseline push failed: ${push.out}`);
    await gitAuth(base, baseline_token, "push", "origin", "+refs/notes/commits").catch(() => {});

    const mergedSha = (await git(base, "rev-parse", "HEAD")).out.trim();
    await api(`/tasks/${task_id}/merged`, {
      method: "POST",
      body: JSON.stringify({ merged_sha: mergedSha, rebased }),
    });
    console.log(`[merge] ${task_id}: merged into mainline ${mergedSha.slice(0, 8)}${rebased ? " (replayed)" : ""}`);
    return true;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

async function seedBaseline(dir, repoName) {
  const abs = path.resolve(process.cwd(), dir);
  if (!existsSync(abs)) throw new Error(`baseline dir not found: ${abs}`);
  const boot = await api("/bootstrap", {
    method: "POST",
    body: JSON.stringify({ repo: repoName, description: "Relay demo baseline" }),
  });
  console.log(`[seed] repo ${boot.name} -> ${boot.remote}`);

  const tmp = await mkdtemp(path.join(os.tmpdir(), "relay-seed-"));
  try {
    await sh("cp", ["-R", abs + "/.", tmp]);
    if (!existsSync(path.join(tmp, ".git"))) await git(tmp, "init", "-b", "main");
    await git(tmp, "add", "-A");
    const log = await git(tmp, "log", "--oneline", "-1");
    const dirty = (await git(tmp, "status", "--porcelain")).out.trim();
    if (!log.out.trim() || dirty) await git(tmp, "commit", "-m", "seed: relay baseline");
    const push = await gitAuth(tmp, boot.token, "push", "-f", boot.remote, "main");
    if (push.code !== 0) throw new Error(`seed push failed: ${push.out}`);
    console.log("[seed] baseline pushed");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) flags[a.slice(2)] = rest[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }

  if (cmd === "config") {
    const [url, token] = pos;
    if (!url || !token) throw new Error("usage: relay-runner config <url> <token>");
    await writeFile(LOCAL_CFG, JSON.stringify({ url, token }, null, 2) + "\n");
    console.log(`[config] wrote ${LOCAL_CFG}`);
    return;
  }
  if (cmd === "seed") {
    await seedBaseline(flags.dir || "../baseline-template", flags.repo || "demo-app");
    return;
  }
  if (cmd === "work") {
    const agent = flags.agent || "claude";
    console.log(`[runner] agent=${agent} once=${!!flags.once}`);
    if (flags.once) {
      const did = await workOnce(agent);
      if (!did) console.log("[runner] no claimable tasks");
      return;
    }
    for (;;) {
      const did = await workOnce(agent).catch((e) => {
        console.error(`[runner] error: ${e.message}`);
        return true;
      });
      if (!did) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (cmd === "merge") {
    console.log(`[merge] loop, once=${!!flags.once}`);
    if (flags.once) {
      const did = await mergeOnce();
      if (!did) console.log("[merge] no pending grants");
      return;
    }
    for (;;) {
      const did = await mergeOnce().catch((e) => {
        console.error(`[merge] error: ${e.message}`);
        return true;
      });
      if (!did) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.error("usage: relay-runner <config|seed|work|merge> [--agent NAME] [--once] [--dir DIR] [--repo NAME]");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
