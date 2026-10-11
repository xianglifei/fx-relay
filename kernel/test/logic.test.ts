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
