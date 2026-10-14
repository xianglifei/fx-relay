import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workspaceName,
  parseWorkspace,
  touchSetOf,
  intersects,
  decideMerge,
  isStaleMerging,
  parseReviewOutput,
  globToRegExp,
  matchGlob,
  normalizePolicy,
  applyPolicy,
  evalChecks,
  DEFAULT_DENY,
} from "../src/logic.ts";

// ---------- workspaceName / parseWorkspace ----------

test("workspaceName/parseWorkspace round-trip", () => {
  const repo = workspaceName("tsk_abc123def", 3);
  assert.equal(repo, "task-abc123def-a3");
  assert.deepEqual(parseWorkspace(repo), { taskId: "tsk_abc123def", attempt: 3 });
});

test("parseWorkspace rejects non-workspace names", () => {
  for (const bad of ["demo-app", "task-", "task-abc", "task-ABC-a0", "task-abc-b0", "", "task--a0"])
    assert.equal(parseWorkspace(bad), null, bad);
});

// ---------- touchSetOf / intersects ----------

test("touchSetOf handles valid, null, and corrupt JSON", () => {
  assert.deepEqual(touchSetOf({ touch_set: '["a.ts","b.ts"]' }), ["a.ts", "b.ts"]);
  assert.deepEqual(touchSetOf({ touch_set: null }), []);
  assert.deepEqual(touchSetOf({ touch_set: "{corrupt" }), []);
  assert.deepEqual(touchSetOf({ touch_set: '"just-a-string"' }), []);
  assert.deepEqual(touchSetOf({}), []);
});

test("intersects", () => {
  assert.equal(intersects(["a"], ["b", "a"]), true);
  assert.equal(intersects(["a"], ["b"]), false);
  assert.equal(intersects([], ["a"]), false);
});

// ---------- decideMerge: the temporal overlap rule ----------

const NOW = "2026-10-11T10:00:00Z";
const mk = (over = {}) => ({
  id: "tsk_x",
  fork_base_sha: "base1",
  forked_at: "2026-10-11T09:00:00Z",
  touch_set: '["style.css"]',
  ...over,
});
const merged = (id, files, at) => ({ id, touch_set: JSON.stringify(files), merged_at: at });

test("no merged tasks: mainline unchanged → fast_forward, moved → rebase", () => {
  assert.deepEqual(decideMerge(mk(), [], "base1"), { action: "fast_forward" });
  assert.deepEqual(decideMerge(mk(), [], "head1"), { action: "rebase" });
});

test("REGRESSION: task merged BEFORE our fork with same files must NOT refork (convergence)", () => {
  const d = decideMerge(mk(), [merged("tsk_older", ["style.css"], "2026-10-11T08:00:00Z")], "base1");
  assert.equal(d.action, "fast_forward");
});

test("merged after fork with disjoint files → rebase", () => {
  const d = decideMerge(mk(), [merged("tsk_newer", ["app.js"], "2026-10-11T09:30:00Z")], "head1");
  assert.deepEqual(d, { action: "rebase" });
});

test("merged after fork with overlapping files → refork with overlap ids", () => {
  const d = decideMerge(mk(), [merged("tsk_newer", ["app.js", "style.css"], "2026-10-11T09:30:00Z")], "head1");
  assert.deepEqual(d, { action: "refork", overlaps: ["tsk_newer"] });
});

test("mixed before/after merges: only after-fork ones counted", () => {
  const d = decideMerge(
    mk(),
    [
      merged("tsk_old", ["style.css"], "2026-10-11T08:00:00Z"),
      merged("tsk_new", ["style.css"], "2026-10-11T09:30:00Z"),
    ],
    "head1",
  );
  assert.deepEqual(d, { action: "refork", overlaps: ["tsk_new"] });
});

test("null head and null fork_base → fast_forward when no overlap", () => {
  assert.deepEqual(decideMerge(mk({ fork_base_sha: null }), [], null), { action: "fast_forward" });
});

test("null forked_at: merged tasks never counted (no crash)", () => {
  const d = decideMerge(mk({ forked_at: null }), [merged("tsk_a", ["style.css"], NOW)], "base1");
  assert.equal(d.action, "fast_forward");
});

test("empty touch_set on awaiting task never triggers refork", () => {
  const d = decideMerge(mk({ touch_set: "[]" }), [merged("tsk_a", ["style.css"], "2026-10-11T09:30:00Z")], "head1");
  assert.equal(d.action, "rebase");
});

// ---------- isStaleMerging ----------

test("isStaleMerging: 11min-old grant with 10min timeout → stale", () => {
  const t = { status: "merging", updated_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() };
  assert.equal(isStaleMerging(t, Date.now(), 10 * 60 * 1000), true);
});

test("isStaleMerging: fresh grant → not stale", () => {
  const t = { status: "merging", updated_at: new Date(Date.now() - 60 * 1000).toISOString() };
  assert.equal(isStaleMerging(t, Date.now(), 10 * 60 * 1000), false);
});

test("isStaleMerging: wrong status / missing / corrupt date → false", () => {
  assert.equal(isStaleMerging({ status: "queued", updated_at: "2020-01-01T00:00:00Z" }, Date.now(), 1000), false);
  assert.equal(isStaleMerging({ status: "merging" }, Date.now(), 1000), false);
  assert.equal(isStaleMerging({ status: "merging", updated_at: "garbage" }, Date.now(), 1000), false);
});

// ---------- parseReviewOutput ----------

const verdictJson = '{"verdict":"reject","reason":"没实现","instructions":"补上按钮"}';

test("parseReviewOutput: OpenAI choices shape", () => {
  const out = { choices: [{ message: { content: verdictJson } }] };
  const r = parseReviewOutput(out);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "reject");
  assert.equal(r.instructions, "补上按钮");
});

test("parseReviewOutput: plain string", () => {
  assert.equal(parseReviewOutput(verdictJson).ok, true);
});

test("parseReviewOutput: markdown-fenced JSON", () => {
  const r = parseReviewOutput('前言\n```json\n{"verdict":"approve","reason":"ok","instructions":""}\n```\n后记');
  assert.equal(r.verdict, "approve");
});

test("parseReviewOutput: {response} wrapper and content-block arrays", () => {
  assert.equal(parseReviewOutput({ response: verdictJson }).ok, true);
  assert.equal(parseReviewOutput([{ type: "text", text: verdictJson }]).ok, true);
});

test("parseReviewOutput: garbage → ok:false with raw preserved", () => {
  const r = parseReviewOutput("模型说:没有办法");
  assert.equal(r.ok, false);
  assert.match(r.raw, /没有办法/);
});

test("parseReviewOutput: verdict normalization — anything not exactly 'approve' is reject", () => {
  const r = parseReviewOutput('{"verdict":"APPROVE"}');
  assert.equal(r.verdict, "reject");
});

// ---------- glob matching ----------

test("globToRegExp: * within segment, ** across, ? single char", () => {
  assert.equal(globToRegExp("*.ts").test("a.ts"), true);
  assert.equal(globToRegExp("*.ts").test("src/a.ts"), false, "* must not cross /");
  assert.equal(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"), true);
  assert.equal(globToRegExp("src/**/*.ts").test("src/a.ts"), true, "**/ should collapse");
  assert.equal(globToRegExp("a?c").test("abc"), true);
  assert.equal(globToRegExp("a?c").test("ac"), false);
  assert.equal(globToRegExp(".env.*").test(".env.local"), true);
  assert.equal(globToRegExp(".env.*").test("x.env.local"), false);
});

test("globToRegExp: regex metacharacters in patterns are literal", () => {
  assert.equal(globToRegExp("a(b).md").test("a(b).md"), true);
  assert.equal(globToRegExp("a+b.md").test("axb.md"), false);
});

test("matchGlob: DEFAULT_DENY catches env files, keys, workflow CI", () => {
  for (const p of [".env", ".env.production", "secrets/id_rsa", "deploy/server.pem", ".github/workflows/deploy.yml"]) {
    assert.equal(matchGlob(p, DEFAULT_DENY), true, p);
  }
  for (const p of ["src/index.ts", "docs/.env-example.md", "README.md"]) {
    assert.equal(matchGlob(p, DEFAULT_DENY), false, p);
  }
});

test("matchGlob: slash-less patterns match basenames at any depth; slashed stay anchored", () => {
  assert.equal(matchGlob("a/b/c/notes.txt", ["*.txt"]), true);
  assert.equal(matchGlob("a/b/c.ts", ["src/*.ts"]), false);
  assert.equal(matchGlob("src/c.ts", ["src/*.ts"]), true);
});

// ---------- normalizePolicy ----------

test("normalizePolicy: sanitizes unknown shapes, clamps numbers, keeps clean lists", () => {
  const p = normalizePolicy({ allow: ["src/**", "", 42], deny: "not-a-list", max_files: 999999, max_diff_bytes: "5000" });
  assert.deepEqual(p.allow, ["src/**"]);
  assert.equal(p.deny, undefined);
  assert.equal(p.max_files, 10000, "clamped to cap");
  assert.equal(p.max_diff_bytes, 5000);
  assert.deepEqual(normalizePolicy(null), {});
  assert.deepEqual(normalizePolicy("junk"), {});
});

// ---------- applyPolicy ----------

test("applyPolicy: default deny → deterministic reject with file named", () => {
  const r = applyPolicy(null, ["src/a.ts", ".env"], 100);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].detail, /\.env/);
  assert.match(r.instructions, /禁改清单/);
});

test("applyPolicy: allowlist excludes untouched areas; deny wins over allow", () => {
  const r = applyPolicy({ allow: ["src/**"] }, ["src/a.ts", "docs/b.md"], 100);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, "allow");
  // even an allowed path is denied if it hits deny
  const r2 = applyPolicy({ allow: ["**"] }, ["prod.pem"], 100);
  assert.equal(r2.ok, false);
  assert.equal(r2.violations[0].rule, "deny");
});

test("applyPolicy: max_files and max_diff_bytes", () => {
  assert.equal(applyPolicy({ max_files: 2 }, ["a", "b", "c"], 10).ok, false);
  assert.equal(applyPolicy(null, ["a"], 200001).ok, false);
  assert.equal(applyPolicy({ max_diff_bytes: 300000 }, ["a"], 200001).ok, true);
  assert.equal(applyPolicy(null, ["a", "b"], 100).ok, true);
});

test("applyPolicy: extra user deny extends the default", () => {
  const r = applyPolicy({ deny: ["migrations/**"] }, ["migrations/001.sql"], 10);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].rule, "deny");
});

// ---------- evalChecks ----------

test("evalChecks: failing test exit → not ok, instructions carry the tail", () => {
  const r = evalChecks({ tests: { cmd: "npm test", exit: 1, tail: "AssertionError: expected 2" } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, ["tests"]);
  assert.match(r.instructions, /AssertionError/);
});

test("evalChecks: passing exits ok; absent checks not judged; exit 0 lint ok", () => {
  assert.equal(evalChecks({ tests: { exit: 0 }, lint: { exit: 0 } }).ok, true);
  assert.equal(evalChecks(null).ok, true);
  assert.equal(evalChecks({ tests: { cmd: "npm test", tail: "no exit recorded" } }).ok, true);
  assert.deepEqual(evalChecks({ tests: null, lint: { exit: 3, tail: "eslint error" } }).failed, ["lint"]);
});
