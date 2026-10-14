#!/usr/bin/env node
/**
 * relay-runner — the execution plane.
 *
 * Commands:
 *   relay-runner task   "spec..." [--file SPEC.md] [--baseline NAME] [--needs-human]
 *                      [--allow g1,g2] [--deny g1] [--max-files N]   # submit a task (submit token ok)
 *   relay-runner attach --dir /path/to/repo --repo NAME              # onboard an existing git repo
 *   relay-runner seed  --dir ../baseline-template [--repo demo-app]  # seed a template dir
 *   relay-runner work  --agent zcode|claude|codebuddy [--once]       # claim + drive a coding agent
 *   relay-runner merge [--once]          # schedule + merge-grant executor (ff / cherry-pick onto mainline)
 *   relay-runner config <url> <token>
 *
 * The runner owns commit, notes, push — the agent only edits files.
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
    submit_token: process.env.RELAY_SUBMIT_TOKEN || file.submit_token || null,
  };
}

async function api(pathname, init = {}, tokenOverride) {
  const c = await cfg();
  const token = tokenOverride || c.token;
  if (!c.url || !token) throw new Error("missing RELAY_URL / RELAY_TOKEN (run `relay-runner config`)");
  const res = await fetch(c.url.replace(/\/$/, "") + pathname, {
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
  const { timeoutMs, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOpts });
    let out = "";
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        p.kill("SIGKILL");
        out += `\n[runner] timed out after ${Math.round(timeoutMs / 1000)}s`;
      }, timeoutMs);
    }
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out });
    });
    p.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out: String(err) });
    });
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

/**
 * Deterministic trust gate: run the baseline's test/lint scripts against the
 * agent's tree. Scripts are read from the FORK BASE, not the agent's HEAD —
 * an agent cannot escape the gate by deleting the test script.
 * Returns null when the baseline defines no scripts (nothing to judge).
 */
async function runBaseChecks(repo, baseSha) {
  const pkgRaw = (await git(repo, "show", `${baseSha}:package.json`)).out;
  if (!pkgRaw.trim().startsWith("{")) return null;
  let scripts = {};
  try { scripts = JSON.parse(pkgRaw).scripts ?? {}; } catch { return null; }
  const hasTest = typeof scripts.test === "string" && scripts.test.trim();
  const hasLint = typeof scripts.lint === "string" && scripts.lint.trim();
  if (!hasTest && !hasLint) return null;

  console.log(`[runner] deterministic gate: installing deps (base scripts: ${[hasTest && "test", hasLint && "lint"].filter(Boolean).join(", ")})`);
  const ci = await sh("npm", ["ci", "--no-audit", "--no-fund", "--silent"], { cwd: repo, timeoutMs: 10 * 60 * 1000 });
  if (ci.code !== 0) {
    const ins = await sh("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: repo, timeoutMs: 10 * 60 * 1000 });
    if (ins.code !== 0) {
      return { tests: { cmd: "npm ci/install (deps for deterministic gate)", exit: -1, tail: (ci.out + "\n" + ins.out).slice(-1500) } };
    }
  }
  const checks = {};
  if (hasTest) {
    const r = await sh("npm", ["test", "--silent"], { cwd: repo, timeoutMs: 10 * 60 * 1000 });
    checks.tests = { cmd: "npm test", exit: r.code, tail: r.out.slice(-2000) };
    console.log(`[runner] npm test exit=${r.code}`);
  }
  if (hasLint) {
    const r = await sh("npm", ["run", "--silent", "lint"], { cwd: repo, timeoutMs: 5 * 60 * 1000 });
    checks.lint = { cmd: "npm run lint", exit: r.code, tail: r.out.slice(-2000) };
    console.log(`[runner] npm run lint exit=${r.code}`);
  }
  return checks;
}

async function executeTask(task, fromStatus, agent) {
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

    // deterministic gate after push: the workspace keeps the agent's commits
    // (remediation needs them), but the kernel will reject on failing checks.
    const checks = await runBaseChecks(repo, baseSha);
    if (checks) provenance.checks = Object.fromEntries(
      Object.entries(checks).map(([k, v]) => [k, { cmd: v.cmd, exit: v.exit }]),
    );

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
        checks,
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
  // self-scheduling: the merge loop drives the scheduler too, so a resident
  // merger is a complete unattended loop (no external /schedule cron needed)
  await api("/schedule", { method: "POST" }).catch((e) => {
    console.error(`[merge] schedule skipped: ${e.message}`);
  });
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

/**
 * Attach an existing git repository: bootstrap the Artifacts repo and push the
 * committed history of the current branch — the source working tree is never touched.
 */
async function attachExisting(dir, repoName) {
  if (!repoName) throw new Error("usage: relay-runner attach --dir /path/to/repo --repo NAME");
  const abs = path.resolve(process.cwd(), dir || ".");
  if (!existsSync(path.join(abs, ".git"))) {
    throw new Error(`${abs} 不是 git 仓库(模板目录请用 seed)`);
  }
  const branch = (await git(abs, "symbolic-ref", "--short", "HEAD")).out.trim();
  if (!branch) throw new Error("源仓库处于 detached HEAD 或无提交,无法 attach");
  const dirty = (await git(abs, "status", "--porcelain")).out.trim();
  if (dirty) console.log("[attach] ⚠ 源仓库有未提交改动,它们不会进入基线(只推送已提交历史)");

  const boot = await api("/bootstrap", {
    method: "POST",
    body: JSON.stringify({ repo: repoName, description: `Relay baseline ${repoName} (attached)` }),
  });
  console.log(`[attach] repo ${boot.name} -> ${boot.remote}`);
  const push = await gitAuth(abs, boot.token, "push", "-f", boot.remote, `${branch}:main`);
  if (push.code !== 0) throw new Error(`attach push failed: ${push.out}`);
  console.log(`[attach] ${repoName} ← ${abs}@${branch} (已提交历史)`);
  console.log(`[attach] 提交任务: relay-runner task "做某事" --baseline ${repoName}`);
}

/** Submit a task — one-liner for humans; submit token is used when configured. */
async function submitTask(flags, pos) {
  let spec = flags.file ? await readFile(path.resolve(String(flags.file)), "utf8") : pos[0];
  if (!spec || !spec.trim()) throw new Error('usage: relay-runner task "spec..." [--file SPEC.md] [--baseline NAME] [--needs-human]');
  spec = spec.trim();
  const body = { spec };
  if (flags.baseline) body.baseline = String(flags.baseline);
  if (flags["needs-human"] || flags.needs_human) body.needs_human_review = true;
  const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
  const policy = {};
  if (flags.allow) policy.allow = list(flags.allow);
  if (flags.deny) policy.deny = list(flags.deny);
  if (flags["max-files"]) policy.max_files = Number(flags["max-files"]);
  if (Object.keys(policy).length) body.policy = policy;
  const c = await cfg();
  const task = await api("/tasks", { method: "POST", body: JSON.stringify(body) }, c.submit_token || undefined);
  const extra = [
    task.needs_human_review ? "需人审" : null,
    task.policy ? "policy" : null,
  ].filter(Boolean).join(", ");
  console.log(`[task] ${task.id} 已创建 (baseline ${task.baseline_repo}${extra ? ", " + extra : ""})`);
  console.log(`[task] 看板: ${c.url}/  |  认领: relay-runner work --agent claude`);
  return task;
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
  if (cmd === "attach") {
    await attachExisting(flags.dir || ".", flags.repo);
    return;
  }
  if (cmd === "task") {
    await submitTask(flags, pos);
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
      let did = true;
      try {
        did = await workOnce(agent);
      } catch (e) {
        console.error(`[runner] error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 15000)); // daemon mode: back off, don't hot-loop
        continue;
      }
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
      let did = true;
      try {
        did = await mergeOnce();
      } catch (e) {
        console.error(`[merge] error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 15000)); // daemon mode: back off, don't hot-loop
        continue;
      }
      if (!did) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.error("usage: relay-runner <task|attach|seed|work|merge|config> [args]");
  console.error("  task   \"spec...\" [--file SPEC.md] [--baseline NAME] [--needs-human] [--allow g,...] [--deny g,...] [--max-files N]");
  console.error("  attach --dir /path/to/repo --repo NAME");
  console.error("  seed   --dir ../baseline-template [--repo demo-app]");
  console.error("  work   --agent claude|codebuddy|zcode [--once]");
  console.error("  merge  [--once]");
  console.error("  config <url> <token>");
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
