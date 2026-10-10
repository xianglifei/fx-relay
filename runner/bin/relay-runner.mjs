#!/usr/bin/env node
/**
 * relay-runner — the execution plane. Polls relay-kernel for tasks, drives a
 * real coding agent headless in a clone of the forked workspace, then commits,
 * attaches provenance as git notes, pushes, and reports the touch-set.
 *
 * Usage:
 *   relay-runner seed --dir ../baseline-template [--repo demo-app]
 *   relay-runner work --agent zcode [--once] [--concurrency 1]
 *
 * Config: RELAY_URL, RELAY_TOKEN env vars (or a relay.local.json next to this
 * file, gitignored, written by `relay-runner config`).
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
  return [
    "你是被 Relay 平台派来的编码 agent,在一个独立工作区里完成一项编码任务。",
    "",
    `## 任务规格\n${task.spec}`,
    "",
    "## 规则",
    "1. 阅读仓库根目录的 AGENTS.md 并遵守其中的项目约定;",
    "2. 只修改与任务相关的文件,保持改动最小;",
    "3. 完成后用 git 提交所有改动,提交信息格式:`task: <一句话摘要>`;",
    "4. 不要执行 git push(push 由 runner 负责),不要改动 git 配置或远程地址;",
    "5. 如果任务无法完成,在仓库根目录写一个 RELAY_FAILURE.md 说明原因。",
  ].join("\n");
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
  const target = tasks[0]; // oldest claimable
  const task = await api(`/tasks/${target.id}/claim`, {
    method: "POST",
    body: JSON.stringify({ agent }),
  }).catch(() => null);
  if (!task) return true; // lost the race, loop again

  console.log(`[runner] claimed ${task.id} (attempt ${task.attempt})`);
  console.log(`[runner] spec: ${task.spec}`);

  const workdir = await mkdtemp(path.join(os.tmpdir(), `relay-${task.id}-`));
  try {
    const clone = await gitAuth(
      workdir, task.write_token, "clone", task.workspace_remote, "repo",
    );
    if (clone.code !== 0) throw new Error(`clone failed: ${clone.out}`);
    const repo = path.join(workdir, "repo");

    // Base sha as observed at clone time — more reliable than the kernel's
    // fork-time snapshot (fork indexing may lag right after a push).
    const baseSha =
      (await git(repo, "rev-parse", "HEAD")).out.trim() || task.fork_base_sha;
    if (!baseSha) throw new Error("cannot determine fork base sha");

    await runAgent(agent, buildPrompt(task), repo);

    // Commit any leftovers the agent left uncommitted.
    await git(repo, "add", "-A");
    const st = await git(repo, "status", "--porcelain");
    if (st.out.trim()) {
      await git(repo, "commit", "-m", "task: agent follow-up commit of remaining changes");
    }

    // Verify there is actually a new commit.
    const head = await git(repo, "rev-parse", "HEAD");
    const headSha = head.out.trim();
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
      fork_base: task.fork_base_sha,
      runner: "relay-runner/0.1",
      pushed_at: new Date().toISOString(),
    };
    await git(repo, "notes", "add", "-f", "-m", JSON.stringify(provenance), headSha);

    const push = await gitAuth(
      repo, task.write_token, "push", "origin", "HEAD:main",
    );
    if (push.code !== 0) throw new Error(`push failed: ${push.out}`);
    // Notes travel in refs/notes/* — push them too when the remote accepts.
    await gitAuth(repo, task.write_token, "push", "origin", "refs/notes/commits");

    const diff = await git(repo, "diff", "--name-only", `${baseSha}..HEAD`);
    const touchSet = diff.out.split("\n").map((s) => s.trim()).filter(Boolean);

    await api(`/tasks/${task.id}/report`, {
      method: "POST",
      body: JSON.stringify({
        result: "pushed",
        head_sha: headSha,
        touch_set: touchSet,
        provenance,
      }),
    });
    console.log(`[runner] ${task.id}: pushed ${headSha.slice(0, 8)} touch=${touchSet.length} files`);
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
    const has = await git(tmp, "diff", "--cached", "--quiet").then((r) => r.code === 0 ? "" : "x");
    const log = await git(tmp, "log", "--oneline", "-1");
    if (!log.out.trim() || has === "x") {
      await git(tmp, "commit", "-m", "seed: relay baseline");
    }
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
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--"))
        flags[a.slice(2)] = rest[++i];
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
    const agent = flags.agent || "zcode";
    console.log(`[runner] agent=${agent} once=${!!flags.once}`);
    if (flags.once) {
      const did = await workOnce(agent);
      if (!did) console.log("[runner] no queued tasks");
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
  console.error("usage: relay-runner <config|seed|work> [--agent zcode|claude] [--once] [--dir DIR] [--repo NAME]");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
