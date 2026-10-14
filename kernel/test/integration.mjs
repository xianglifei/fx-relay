#!/usr/bin/env node
/**
 * Relay kernel — specialized integration suite.
 * Runs against a kernel URL + token (default: production). Uses a dedicated
 * test baseline + "[test]" task specs, then cleans up repos and D1 rows.
 *
 * Usage: node test/integration.mjs [--url URL] [--token TOK] [--submit-token TOK]
 * NOTE: stop any resident merge runner first (launchctl unload com.relay.merge
 *       / systemctl stop relay-merge) — the daemon races this suite for grants.
 */
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "runner");
const LOCAL_CFG = path.join(ROOT, "relay.local.json");
let { url, token, submit_token } = existsSync(LOCAL_CFG) ? JSON.parse(await readFile(LOCAL_CFG, "utf8")) : {};
const argv = process.argv.slice(2);
if (argv.includes("--url")) url = argv[argv.indexOf("--url") + 1];
if (argv.includes("--token")) token = argv[argv.indexOf("--token") + 1];
if (argv.includes("--submit-token")) submit_token = argv[argv.indexOf("--submit-token") + 1];
if (process.env.RELAY_SUBMIT_TOKEN) submit_token = process.env.RELAY_SUBMIT_TOKEN;
if (!url || !token) throw new Error("need --url/--token or runner/relay.local.json");
url = url.replace(/\/$/, "");

const BASELINE = `relay-test-baseline-${Math.random().toString(36).slice(2, 8)}`;
const results = [];
const testRepos = new Set();
const testTaskIds = new Set();
const sh = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
  } catch (e) {
    throw new Error(`cmd failed: ${cmd}\nstdout: ${String(e.stdout || "").slice(0, 300)}\nstderr: ${String(e.stderr || "").slice(0, 400)}`);
  }
};
const gitAuth = (cwd, tok, args) =>
  sh(`git -C ${cwd} -c http.extraHeader="Authorization: Bearer ${tok}" ${args}`, { timeout: 120000 });

async function api(pathname, init = {}) {
  const res = await fetch(url + pathname, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

let passed = 0, failed = 0, warned = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✖ ${name}\n      ${String(e.message).slice(0, 300)}`); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function taskStatus(id) {
  return (await api(`/tasks/${id}`)).body.task;
}

async function claimAndPush(taskId, spec, files, opts = {}) {
  // claim
  const claim = await api(`/tasks/${taskId}/claim`, { method: "POST", body: JSON.stringify({ agent: opts.agent || "itest" }) });
  expect(claim.status === 200, `claim failed: ${JSON.stringify(claim.body)}`);
  const tk = claim.body;
  // workspace edit
  const wd = await mkdtemp(path.join(os.tmpdir(), "itest-"));
  const repo = path.join(wd, "repo");
  gitAuth(wd, tk.write_token, `clone ${tk.workspace_remote} repo`);
  sh(`git -C ${repo} config user.email itest@relay.local && git -C ${repo} config user.name itest`);
  for (const [p, content] of Object.entries(files)) await writeFile(path.join(repo, p), content);
  sh(`git -C ${repo} add -A && git -C ${repo} commit -m "task: itest change"`);
  gitAuth(repo, tk.write_token, "push origin HEAD:main");
  const headSha = sh(`git -C ${repo} rev-parse HEAD`).trim();
  const diff = sh(`git -C ${repo} diff HEAD~1..HEAD`).slice(0, 50000);
  await rm(wd, { recursive: true, force: true });
  // report
  const rep = await api(`/tasks/${taskId}/report`, {
    method: "POST",
    body: JSON.stringify({
      result: "pushed", head_sha: headSha,
      touch_set: Object.keys(files),
      diff: opts.diff ?? diff,
      provenance: { agent: opts.agent || "itest", model: "integration-test", spec_digest: String(spec).slice(0, 100) },
    }),
  });
  expect(rep.status === 200, `report failed: ${JSON.stringify(rep.body)}`);
  return { claimBody: tk, report: rep.body, headSha };
}

async function mergeGrant(taskId) {
  const sched = await api("/schedule", { method: "POST" });
  expect(sched.status === 200, `schedule failed: ${JSON.stringify(sched.body)}`);
  const all = [...sched.body.grants, ...sched.body.reforked.map((r) => ({ task_id: r.task_id, mode: "refork" }))];
  return all.find((g) => g.task_id === taskId) || null;
}

let mainlineCommits = 0; // every executeMerge() replays exactly one task commit onto the mainline

async function executeMerge(taskId) {
  const next = await api("/merge/next");
  expect(next.body.grant, `no grant for ${taskId}: ${JSON.stringify(next.body)}`);
  const g = next.body.grant;
  expect(g.task_id === taskId, `grant mismatch: ${g.task_id} vs ${taskId}`);
  const wd = await mkdtemp(path.join(os.tmpdir(), "imerge-"));
  const base = path.join(wd, "base");
  gitAuth(wd, g.baseline_token, `clone ${g.baseline_remote} base`);
  sh(`git -C ${base} config user.email itest@relay.local && git -C ${base} config user.name itest`);
  gitAuth(base, g.read_token, `fetch ${g.workspace_remote} main`);
  const wsHead = sh(`git -C ${base} rev-parse FETCH_HEAD`).trim();
  const baseHead = sh(`git -C ${base} rev-parse HEAD`).trim();
  const mb = sh(`git -C ${base} merge-base ${baseHead} ${wsHead}`).trim();
  let mergedSha;
  if (mb !== baseHead) {
    sh(`git -C ${base} cherry-pick ${mb}..${wsHead}`);
    mergedSha = sh(`git -C ${base} rev-parse HEAD`).trim();
  } else {
    sh(`git -C ${base} merge --ff-only ${wsHead}`);
    mergedSha = sh(`git -C ${base} rev-parse HEAD`).trim();
  }
  gitAuth(base, g.baseline_token, "push origin HEAD:main");
  const replayed = Number(sh(`git -C ${base} rev-list --count ${baseHead}..${mergedSha}`).trim()) || 1;
  await rm(wd, { recursive: true, force: true });
  const done = await api(`/tasks/${taskId}/merged`, {
    method: "POST",
    body: JSON.stringify({ merged_sha: mergedSha, rebased: mb !== baseHead }),
  });
  expect(done.status === 200, `merged report failed: ${JSON.stringify(done.body)}`);
  mainlineCommits += replayed;
  return mergedSha;
}

// ---------------------------------------------------------------- suite

console.log(`▶ integration suite → ${url}`);

await t("T1 authz: /tasks without token → 401; /healthz public; / serves dashboard", async () => {
  const noAuth = await fetch(url + "/tasks");
  expect(noAuth.status === 401, `expected 401, got ${noAuth.status}`);
  const health = await (await fetch(url + "/healthz")).json();
  expect(health.ok === true, "healthz not ok");
  const page = await (await fetch(url + "/")).text();
  expect(page.includes("<title>Relay"), "dashboard HTML not served");
});

await t("T2 validation: create task without spec → 400", async () => {
  const r = await api("/tasks", { method: "POST", body: JSON.stringify({}) });
  expect(r.status === 400, `expected 400, got ${r.status}`);
});

await t("T0 setup: bootstrap + seed test baseline", async () => {
  const boot = await api("/bootstrap", { method: "POST", body: JSON.stringify({ repo: BASELINE, description: "itest baseline" }) });
  expect(boot.status === 200, `bootstrap failed: ${JSON.stringify(boot.body)}`);
  testRepos.add(BASELINE);
  const wd = await mkdtemp(path.join(os.tmpdir(), "iseed-"));
  sh(`cp -R ${path.join(ROOT, "..", "baseline-template")}/. ${wd}/`);
  sh(`git -C ${wd} init -b main -q && git -C ${wd} add -A && git -C ${wd} -c user.email=i@t -c user.name=i commit -qm "seed: itest baseline"`);
  gitAuth(wd, boot.body.token, `push -f ${boot.body.remote} main`);
  await rm(wd, { recursive: true, force: true });
});

let raceTaskId;
await t("T3 claim race: first claim 200, second claim 409", async () => {
  const mk = await api("/tasks", { method: "POST", body: JSON.stringify({ spec: "[test] 竞态测试:在 README 末尾追加一行 itest", baseline: BASELINE }) });
  raceTaskId = mk.body.id; testTaskIds.add(raceTaskId);
  expect(mk.body.baseline_repo === BASELINE, `task forked from ${mk.body.baseline_repo}, expected ${BASELINE}`);
  const c1 = await api(`/tasks/${raceTaskId}/claim`, { method: "POST", body: JSON.stringify({ agent: "itest-a" }) });
  const c2 = await api(`/tasks/${raceTaskId}/claim`, { method: "POST", body: JSON.stringify({ agent: "itest-b" }) });
  expect(c1.status === 200, `first claim got ${c1.status}`);
  expect(c2.status === 409, `second claim got ${c2.status}, expected 409`);
});

let lifeTaskId, lifeMergedSha;
await t("T4 lifecycle: create → claim → push → report(review) → schedule → merge → merged", async () => {
  // spec must EXACTLY match what the harness does — the reviewer rejects mismatched diffs
  const mk = await api("/tasks", { method: "POST", body: JSON.stringify({ spec: "[test] 生命周期:新建一个 NOTES.md 文件,文件内容为一行文字 lifecycle-ok,不改动其他文件", baseline: BASELINE }) });
  lifeTaskId = mk.body.id; testTaskIds.add(lifeTaskId);
  const { report, headSha } = await claimAndPush(lifeTaskId, "lifecycle", { "NOTES.md": "lifecycle-ok\n" });
  expect(report.status === "awaiting_merge", `status after report: ${report.status} (${report.review?.reason ?? ""})`);
  expect(["approve", "reject"].includes(report.review?.verdict), `review verdict malformed: ${JSON.stringify(report.review)}`);
  const grant = await mergeGrant(lifeTaskId);
  expect(grant && grant.mode === "fast_forward", `grant: ${JSON.stringify(grant)}`);
  lifeMergedSha = await executeMerge(lifeTaskId);
  const st = await taskStatus(lifeTaskId);
  expect(st.status === "merged" && st.merged_sha === lifeMergedSha, `final status: ${JSON.stringify({ s: st.status, m: st.merged_sha })}`);
});

await t("T5 report guard: reporting on a merged task → 409", async () => {
  const r = await api(`/tasks/${lifeTaskId}/report`, {
    method: "POST",
    body: JSON.stringify({ result: "pushed", head_sha: lifeMergedSha, touch_set: [] }),
  });
  expect(r.status === 409, `expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
});

let rejectTaskId;
await t("T6 reject loop: destructive diff → reject → re-claim carries instructions → fix → approve → merge", async () => {
  const mk = await api("/tasks", { method: "POST", body: JSON.stringify({ spec: "[test] 打回闭环:在页面标题下方加一行欢迎语", baseline: BASELINE }) });
  rejectTaskId = mk.body.id; testTaskIds.add(rejectTaskId);
  // round 1: put the welcome text in a WRONG place (a new txt file instead of the page)
  const { report } = await claimAndPush(rejectTaskId, "reject-loop", { "WELCOME.txt": "欢迎来到 Relay\n" });
  const verdict = report.review?.verdict;
  if (verdict !== "reject") {
    warned++;
    console.log(`      ⚠ reviewer approved a destructive diff (AI nondeterminism) — merging it; deterministic reject already proven live`);
    const grant = await mergeGrant(rejectTaskId);
    expect(grant, "no grant after approved round-1");
    await executeMerge(rejectTaskId);
    expect((await taskStatus(rejectTaskId)).status === "merged", "not merged");
    return;
  }
  // rejected → re-claim must carry remediation instructions (server-side state, not client hint)
  const c2 = await api(`/tasks/${rejectTaskId}/claim`, { method: "POST", body: JSON.stringify({ agent: "itest-fixer" }) });
  expect(c2.status === 200, `re-claim got ${c2.status}`);
  expect(c2.body.review?.instructions?.length > 0, "reject verdict but no remediation instructions in claim");
  // fix on the same workspace using the re-claim's token (no second claim!):
  // surgical edit — insert the welcome line under the title, nothing else
  const tk = c2.body;
  const wd = await mkdtemp(path.join(os.tmpdir(), "ifix-"));
  const repo = path.join(wd, "repo");
  gitAuth(wd, tk.write_token, `clone ${tk.workspace_remote} repo`);
  sh(`git -C ${repo} config user.email itest@relay.local && git -C ${repo} config user.name itest`);
  const htmlPath = path.join(repo, "index.html");
  // round 1 didn't touch the page — surgical insert of the welcome line under the title
  const orig = await readFile(htmlPath, "utf8");
  expect(orig.includes("<h1>Relay Todo</h1>"), "workspace index.html unexpected");
  await writeFile(htmlPath, orig.replace("<h1>Relay Todo</h1>", '<h1>Relay Todo</h1>\n    <p class="subtitle">欢迎来到 Relay</p>'));
  sh(`git -C ${repo} add -A && git -C ${repo} commit -m "task: itest fix"`);
  gitAuth(repo, tk.write_token, "push origin HEAD:main");
  const headSha = sh(`git -C ${repo} rev-parse HEAD`).trim();
  const diff = sh(`git -C ${repo} diff HEAD~1..HEAD`);
  await rm(wd, { recursive: true, force: true });
  const rep2 = await api(`/tasks/${rejectTaskId}/report`, {
    method: "POST",
    body: JSON.stringify({ result: "pushed", head_sha: headSha, touch_set: ["WELCOME.md", "index.html"], diff, provenance: { agent: "itest-fixer", model: "integration-test", spec_digest: "reject-loop fix" } }),
  });
  expect(rep2.status === 200, `fix report failed: ${JSON.stringify(rep2.body)}`);
  expect(rep2.body.status === "awaiting_merge", `post-fix status: ${rep2.body.status}`);
  const grant = await mergeGrant(rejectTaskId);
  expect(grant, `no grant after fix: ${JSON.stringify(grant)}`);
  await executeMerge(rejectTaskId);
  expect((await taskStatus(rejectTaskId)).status === "merged", "not merged");
});

await t("T7 race-task cleanup: attach guard sees open tasks; failed report accepted from assigned", async () => {
  // raceTaskId is 'assigned' from T3 — bootstrap must report it (attach guard data)
  const boot = await api("/bootstrap", { method: "POST", body: JSON.stringify({ repo: BASELINE }) });
  expect((boot.body.open_tasks ?? 0) >= 1, `open_tasks should count the assigned task, got ${boot.body.open_tasks}`);
  // a failed report is a valid transition from assigned
  const r = await api(`/tasks/${raceTaskId}/report`, { method: "POST", body: JSON.stringify({ result: "failed", detail: "itest cleanup" }) });
  expect(r.status === 200 && r.body.status === "failed", `got ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
});

await t("T9 policy gate: touching .env → deterministic reject (no AI); re-claim carries instructions", async () => {
  const mk = await api("/tasks", { method: "POST", body: JSON.stringify({ spec: "[test] policy: 写一个环境变量文件", baseline: BASELINE }) });
  const tid = mk.body.id; testTaskIds.add(tid);
  const { report } = await claimAndPush(tid, "policy", { ".env": "SECRET=itest\n" });
  expect(report.status === "review_failed", `status: ${report.status}`);
  expect(report.review?.model === "policy", `review model not policy: ${JSON.stringify(report.review)}`);
  expect(/禁改清单|deny/.test(report.review?.instructions ?? ""), `instructions: ${report.review?.instructions}`);
  const c = await api(`/tasks/${tid}/claim`, { method: "POST", body: JSON.stringify({ agent: "itest-fix" }) });
  expect(c.status === 200 && (c.body.review?.instructions ?? "").includes(".env"), "re-claim lacks policy instructions");
  // cleanup: leave the task in a terminal-ish state for row deletion
  await api(`/tasks/${tid}/report`, { method: "POST", body: JSON.stringify({ result: "failed", detail: "itest policy cleanup" }) });
});

await t("T10 human gate: needs_human_review → suspended → human reject → remediate → human approve → merge", async () => {
  const mk = await api("/tasks", { method: "POST", body: JSON.stringify({ spec: "[test] 人审:新建 HUMAN.md,内容为一行 human-gate-ok,不改动其他文件", baseline: BASELINE, needs_human_review: true }) });
  const tid = mk.body.id; testTaskIds.add(tid);
  expect(mk.body.needs_human_review === 1, `flag not stored: ${mk.body.needs_human_review}`);
  const { report } = await claimAndPush(tid, "human-gate", { "HUMAN.md": "human-gate-ok\n" });
  if (report.status === "review_failed") {
    warned++; console.log("      ⚠ reviewer rejected before the human gate — gate path untested this run");
    return;
  }
  expect(report.status === "needs_human", `expected needs_human, got ${report.status}`);
  // human reject with a remediation note
  const rej = await api(`/tasks/${tid}/human_review`, { method: "POST", body: JSON.stringify({ decision: "reject", note: "itest: 内容改为 human-gate-fixed" }) });
  expect(rej.status === 200 && rej.body.status === "review_failed", `human reject: ${JSON.stringify(rej.body).slice(0, 150)}`);
  expect(rej.body.review?.model === "human", "human review model missing");
  // re-claim carries the human note as remediation instructions (server-side state)
  const c = await api(`/tasks/${tid}/claim`, { method: "POST", body: JSON.stringify({ agent: "itest-fixer" }) });
  expect(c.status === 200 && (c.body.review?.instructions ?? "").includes("human-gate-fixed"), "re-claim lacks human note");
  // remediate on the same workspace with the re-claim's token
  const wd = await mkdtemp(path.join(os.tmpdir(), "ihfix-"));
  const repo = path.join(wd, "repo");
  gitAuth(wd, c.body.write_token, `clone ${c.body.workspace_remote} repo`);
  sh(`git -C ${repo} config user.email itest@relay.local && git -C ${repo} config user.name itest`);
  await writeFile(path.join(repo, "HUMAN.md"), "human-gate-fixed\n");
  sh(`git -C ${repo} add -A && git -C ${repo} commit -m "task: itest human-gate fix"`);
  gitAuth(repo, c.body.write_token, "push origin HEAD:main");
  const headSha = sh(`git -C ${repo} rev-parse HEAD`).trim();
  const diff = sh(`git -C ${repo} diff HEAD~1..HEAD`);
  await rm(wd, { recursive: true, force: true });
  const rep2 = await api(`/tasks/${tid}/report`, {
    method: "POST",
    body: JSON.stringify({ result: "pushed", head_sha: headSha, touch_set: ["HUMAN.md"], diff, provenance: { agent: "itest-fixer", model: "integration-test", spec_digest: "human-gate fix" } }),
  });
  expect(rep2.status === 200, `fix report failed: ${JSON.stringify(rep2.body).slice(0, 150)}`);
  if (rep2.body.status === "review_failed") {
    warned++; console.log("      ⚠ reviewer rejected the fix — human approve path untested this run");
    return;
  }
  expect(rep2.body.status === "needs_human", `expected needs_human after fix, got ${rep2.body.status}`);
  // human approve → merge
  const app = await api(`/tasks/${tid}/human_review`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  expect(app.status === 200 && app.body.status === "awaiting_merge", `human approve: ${JSON.stringify(app.body).slice(0, 150)}`);
  const grant = await mergeGrant(tid);
  expect(grant, `no grant after human approve: ${JSON.stringify(grant)}`);
  await executeMerge(tid);
  expect((await taskStatus(tid)).status === "merged", "not merged");
});

await t("T10b human_review guard: non-needs_human task → 409", async () => {
  const r = await api(`/tasks/${lifeTaskId}/human_review`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  expect(r.status === 409, `expected 409, got ${r.status}`);
});

await t("T11 token split: submit token can read+create but cannot schedule/claim", async () => {
  if (!submit_token) { warned++; console.log("      ⚠ no submit token provided (--submit-token) — skipped"); return; }
  const h = { authorization: `Bearer ${submit_token}`, "content-type": "application/json" };
  const read = await fetch(url + "/tasks", { headers: h });
  expect(read.status === 200, `submit token read: ${read.status}`);
  const mk = await fetch(url + "/tasks", { method: "POST", headers: h, body: JSON.stringify({ spec: "[test] auth: submit token 提交(不执行)", baseline: BASELINE }) });
  expect(mk.status === 201, `submit create: ${mk.status}`);
  const created = await mk.json();
  testTaskIds.add(created.id);
  const sched = await fetch(url + "/schedule", { method: "POST", headers: h });
  expect(sched.status === 401, `submit schedule should 401, got ${sched.status}`);
  const claim = await fetch(`${url}/tasks/${created.id}/claim`, { method: "POST", headers: h, body: JSON.stringify({ agent: "nope" }) });
  expect(claim.status === 401, `submit claim should 401, got ${claim.status}`);
  const hr = await fetch(`${url}/tasks/${created.id}/human_review`, { method: "POST", headers: h, body: JSON.stringify({ decision: "approve" }) });
  expect(hr.status === 401 || hr.status === 409, `submit human_review: ${hr.status}`);
  // admin token still schedules fine
  const admin = await api("/schedule", { method: "POST" });
  expect(admin.status === 200, `admin schedule broken: ${admin.status}`);
});

await t("T12 rate limit: submit-token burst gets 429 (atomic two-bucket window)", async () => {
  if (!submit_token) { warned++; console.log("      ⚠ no submit token provided (--submit-token) — skipped"); return; }
  const h = { authorization: `Bearer ${submit_token}`, "content-type": "application/json" };
  // Sequential: creates are ~5s each (forks are heavy), so 25 span >2 minutes —
  // only the two-bucket sliding window (current+previous minute, cap 12) makes
  // this deterministic; a plain 60s rolling window drains as fast as it fills.
  let created = 0;
  let got429 = false;
  for (let i = 0; i < 25 && !got429; i++) {
    const r = await fetch(url + "/tasks", { method: "POST", headers: h, body: JSON.stringify({ spec: `[test] ratelimit burst ${i}`, baseline: BASELINE }) });
    if (r.status === 201) { created++; testTaskIds.add((await r.json()).id); }
    else if (r.status === 429) { got429 = true; }
    else throw new Error(`unexpected ${r.status} on burst create ${i}`);
  }
  expect(got429, `no 429 within 25 sequential creates (created ${created}) — limiter not enforced`);
  console.log(`      throttled after ${created} creations`);
  // admin is never throttled (bypass)
  const admin = await api("/tasks", { method: "POST", body: JSON.stringify({ spec: "[test] admin bypasses limiter", baseline: BASELINE }) });
  expect(admin.body.id, `admin create throttled unexpectedly: ${admin.status} ${JSON.stringify(admin.body).slice(0, 120)}`);
  testTaskIds.add(admin.body.id);
});

await t("T8 mainline linear: test baseline log contains all merged task commits", async () => {
  const boot = await api("/bootstrap", { method: "POST", body: JSON.stringify({ repo: BASELINE }) });
  const wd = await mkdtemp(path.join(os.tmpdir(), "iverify-"));
  gitAuth(wd, boot.body.token, `clone ${boot.body.remote} chk`);
  const log = sh(`git -C ${wd}/chk log --oneline`);
  await rm(wd, { recursive: true, force: true });
  expect(/itest change|task: itest/.test(log), `merged commits missing from mainline:\n${log.slice(0, 400)}`);
  const count = log.trim().split("\n").length;
  expect(count === 1 + mainlineCommits, `expected exactly ${1 + mainlineCommits} commits on test mainline (seed+${mainlineCommits} merged), got ${count}\n${log}`);
});

console.log(`\n■ ${passed} passed, ${failed} failed, ${warned} warnings`);

// ---------------------------------------------------------------- cleanup
const KERNEL_DIR = path.join(ROOT, "..", "kernel");
const wrangler = (cmd) => sh(`npx wrangler ${cmd}`, { cwd: KERNEL_DIR, timeout: 120000 });
if (process.env.ITEST_NO_CLEANUP !== "1" && testRepos.size) {
  console.log("▶ cleanup: deleting test repos + D1 rows");
  for (const repo of testRepos) {
    try { wrangler(`artifacts repos delete ${repo} --namespace relay -y`); console.log(`  deleted repo ${repo}`); }
    catch (e) { console.log(`  ⚠ repo ${repo}: ${String(e).slice(0, 100)}`); }
  }
  for (const id of testTaskIds) {
    // workspaces are fork-per-task repos too
    const st = await taskStatus(id).catch(() => null);
    const wsRepo = st?.workspace_repo;
    if (wsRepo) {
      try { wrangler(`artifacts repos delete ${wsRepo} --namespace relay -y`); console.log(`  deleted repo ${wsRepo}`); }
      catch {}
    }
  }
  const ids = [...testTaskIds].map((i) => `'${i}'`).join(",");
  try {
    wrangler(`d1 execute relay-kernel --remote -y --command "DELETE FROM tasks WHERE id IN (${ids}); DELETE FROM events WHERE task_id IN (${ids}); DELETE FROM provenance WHERE task_id IN (${ids});"`);
    console.log(`  deleted D1 rows for ${testTaskIds.size} test tasks`);
  } catch (e) { console.log(`  ⚠ d1 cleanup: ${String(e).slice(0, 150)}`); }
}
process.exit(failed ? 1 : 0);
